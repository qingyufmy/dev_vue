// ai/strategy.js — 策略上下文 + 执行 + 分析

import { queryOne, queryAll, queryRun, beijingNow, withTransaction } from '../../db.js'
import { isTradeEnabled, sendToBrowsers } from '../../bridge-ws.js'
import { STRATEGY_TIMEFRAME_COUNTS, attachSignalTiming, parseTimeframeTags, compactRates, signalTtlSeconds, stripBrokerSuffix } from './utils.js'
import { getChanWindowPolicy, CHAN_WINDOW_POLICY_VERSION } from './chan-window-policy.js'
import { mt5Bridge, platformRates, calculateMarketData, computeAtr14 } from './market-data.js'
import { maybeAiSignal } from './llm.js'
import { getAnalyzeApiKey, insertAudit, signalOrderPayload, executeOrderCore, DEFAULT_MAX_POSITION_SIZE, parsePromptSymbols } from './config.js'
import { resolveOwnedModelProfileForRuntime } from './model-profiles.js'
import { createStrategyMemoryInjectionLog, getStrategyMemoryLibraryForRuntime,
  updateStrategyMemoryInjectionLog } from './strategy-memory-library.js'
import { buildSharedMarketSnapshot, persistInferenceSnapshotTx } from './inference-snapshots.js'
import { getStrategyById } from './strategy-ownership.js'
import { parseStrategyPolicy, prepareStrategyDataRuntime, buildStrategyRuntimeSnapshot } from './strategy-policy.js'
import { attachSignalPresentation, normalizeDecisionFields, SIGNAL_SCHEMA_VERSION } from './signal-presentation.js'
import { buildDecisionDiagnostics } from './decision-diagnostics.js'
import { saveChanStructureAnchor } from './platform-market-data.js'
import { loadPeriodMarketWindow } from './period-market-evidence.js'
import { normalizeBacktestOptions, simulateVirtualAccount } from './model-backtest.js'
import { resolveModelSnapshotSelection } from './model-snapshot-samples.js'
import { resolvePlatformAiVolumeRange } from './risk-policy.js'
import { createModelTaskTracker } from './model-task-tracker.js'
import { modelProviderProtocol } from './model-providers.js'
import { createTradeThesisTx, hasActivePositionManagementGroups,
  loadActivePositionManagementContext, persistPositionManagementEvaluations } from './position-management.js'
import { indicatorRequiredHistory } from './indicator-registry.js'
import { resolveDefaultObserverClockBootstrap, trustedTerminalClock } from './terminal-clock.js'
import { modelTaskDeadlines } from './model-task-budget.js'
import { attachExecutionValidationToDecision, executionValidationRejection, readExecutionValidation } from './signal-execution-validation.js'
import crypto from 'node:crypto'

const ATR_ANCHOR_PRIORITY = ['H1', 'H4']
const TIMEFRAME_MINUTES = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440, W1: 10080 }
const HISTORY_COMPARE_MIN_CONTEXT = 20
const HISTORY_COMPARE_MAX_STEPS = 30
const HISTORY_COMPARE_MIN_STEPS = 4
const HISTORY_COMPARE_MAX_KLINES = 5000
const HISTORY_COMPARE_MAX_CONTINUOUS_STEPS = 120
const HISTORY_COMPARE_FUTURE_TOLERANCE_MS = 5 * 60_000

function normalizeCompareTimezoneOffset(value) {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= -14 * 60 && numeric <= 14 * 60
    ? Math.trunc(numeric)
    : null
}

function timezoneOffsetSuffix(offsetMinutes) {
  const normalized = normalizeCompareTimezoneOffset(offsetMinutes)
  if (normalized == null) throw new Error('terminal_clock_unverified')
  const sign = normalized >= 0 ? '+' : '-'
  const absolute = Math.abs(normalized)
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
}

function parseCompareTimeUtcMs(value, timezoneOffsetMinutes) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const hasTimezone = /T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)
  const normalized = raw.includes('T')
    ? raw
    : raw.includes(' ') ? raw.replace(' ', 'T') : `${raw}T00:00:00`
  const parsed = Date.parse(hasTimezone ? normalized : `${normalized}${timezoneOffsetSuffix(timezoneOffsetMinutes)}`)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeHistoryCompareTimeRange(startTime, endTime, timezoneOffsetMinutes, nowMs = Date.now()) {
  const startUtcMs = parseCompareTimeUtcMs(startTime, timezoneOffsetMinutes)
  const endUtcMs = parseCompareTimeUtcMs(endTime, timezoneOffsetMinutes)
  if (!startUtcMs || !endUtcMs || endUtcMs <= startUtcMs) {
    throw new Error('invalid_history_time_range')
  }
  if (endUtcMs > Number(nowMs) + HISTORY_COMPARE_FUTURE_TOLERANCE_MS) {
    throw new Error('history_compare_end_time_in_future')
  }
  return {
    startUtcMs,
    endUtcMs,
    startTime:new Date(startUtcMs).toISOString(),
    endTime:new Date(endUtcMs).toISOString(),
  }
}

async function resolveCompareTimezoneOffset(params = {}) {
  const strategyId = Number(params.strategy_id)
  const tradingAccountId = Number(params.trading_account_id)
  const userId = Number(params.user_id)
  let row = null
  if (strategyId > 0) {
    row = await queryOne(`SELECT accounts.broker_server,
      mds.timezone_offset_minutes, mds.clock_status
      FROM ai_observer_sources sources
      JOIN trading_accounts accounts ON accounts.id = sources.trading_account_id
      LEFT JOIN market_data_sources mds ON mds.bridge_user_id = sources.bridge_user_id
        AND UPPER(COALESCE(mds.broker_server, '')) = UPPER(accounts.broker_server)
        AND CAST(COALESCE(mds.account_login, 0) AS CHAR) = CAST(accounts.login_account AS CHAR)
      WHERE sources.strategy_id = ? AND sources.status = 'active'
      ORDER BY mds.last_calibrated_at DESC, mds.id DESC LIMIT 1`, [strategyId])
  }
  if (!row && tradingAccountId > 0) {
    row = await queryOne(`SELECT accounts.broker_server,
      mds.timezone_offset_minutes, mds.clock_status
      FROM trading_accounts accounts
      LEFT JOIN market_data_sources mds ON mds.bridge_user_id = accounts.user_id
        AND UPPER(COALESCE(mds.broker_server, '')) = UPPER(accounts.broker_server)
        AND CAST(COALESCE(mds.account_login, 0) AS CHAR) = CAST(accounts.login_account AS CHAR)
      WHERE accounts.id = ? ${userId > 0 ? 'AND accounts.user_id = ?' : ''}
      ORDER BY mds.last_calibrated_at DESC, mds.id DESC LIMIT 1`,
    [tradingAccountId, ...(userId > 0 ? [userId] : [])])
  }
  const clock = await resolveDefaultObserverClockBootstrap(row || {})
  const offset = normalizeCompareTimezoneOffset(clock?.timezone_offset_minutes)
  if (offset == null || !trustedTerminalClock(clock)) {
    throw new Error('terminal_clock_unverified')
  }
  return offset
}

function comparisonDirection(signalType) {
  const normalized = String(signalType || '').toLowerCase()
  if (['buy', 'buy_limit', 'buy_stop', 'buy_stop_limit'].includes(normalized)) return 'buy'
  if (['sell', 'sell_limit', 'sell_stop', 'sell_stop_limit'].includes(normalized)) return 'sell'
  return normalized === 'hold' ? 'hold' : 'unknown'
}

function boundedComparisonError(value, fallback = 'history_compare_failed', maximum = 500) {
  const text = String(value || fallback).trim() || fallback
  return text.length <= maximum ? text : text.slice(0, maximum)
}

function comparisonFingerprint(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  return crypto.createHash('sha256').update(serialized).digest('hex')
}

function compareMemoryIdentity(library, { missingCode = 'strategy_memory_library_unavailable', invalidCode = 'history_compare_memory_snapshot_invalid' } = {}) {
  if (!library) throw Object.assign(new Error(missingCode), { code:missingCode })
  const versionNo = Number(library.version_no)
  const hasContent = Object.hasOwn(library, 'content_text')
    && library.content_text !== null && library.content_text !== undefined
  const contentText = hasContent ? String(library.content_text) : ''
  const contentHash = String(library.content_hash || '')
  if (!Number.isSafeInteger(versionNo) || versionNo < 0
    || !hasContent
    || !/^[a-f0-9]{64}$/i.test(contentHash)
    || comparisonFingerprint(contentText) !== contentHash) {
    throw Object.assign(new Error(invalidCode), { code:invalidCode })
  }
  return { version_no:versionNo, content_hash:contentHash.toLowerCase(), content_text:contentText }
}

function modelIdentityFromConfig(config = {}) {
  const provider = config.api_provider || config.provider || null
  return {
    provider:provider ? String(provider) : null,
    model:config.model_name || config.model ? String(config.model_name || config.model) : null,
    modelProfileId:Number(config._model_profile_id || config.model_profile_id) || null,
    protocol:config.protocol || config._protocol || modelProviderProtocol(provider) || null,
    credentialSource:config._credential_source || config.credential_source || null,
  }
}

function assertExpectedModelIdentity(config, expected) {
  if (!expected) return
  const actual = modelIdentityFromConfig(config)
  const fields = ['provider', 'model', 'modelProfileId', 'protocol', 'credentialSource']
  if (fields.some(field => String(actual[field] ?? '') !== String(expected[field] ?? ''))) {
    throw Object.assign(new Error('manual_analysis_model_stale'), { code:'manual_analysis_model_stale' })
  }
}

// Injection logs are intentionally append-only audit rows and the existing
// schema does not provide a uniqueness constraint.  A compare unit can be
// resumed after the worker has already created its model task, so reuse the
// exact task/version/usage row before inserting another audit record.
async function ensureCompareStrategyMemoryInjectionLog({ strategyId, actor, library, modelTaskId,
  usageKind = 'model_compare_history' }) {
  const taskId = String(modelTaskId || '').trim()
  if (!taskId) throw new Error('model_compare_memory_task_missing')
  const versionNo = Number(library?.version_no || 0)
  const contentHash = String(library?.content_hash || '')
  const existing = await queryOne(`SELECT * FROM strategy_memory_injection_logs
    WHERE strategy_id = ? AND library_version_no = ? AND library_content_hash = ?
      AND usage_kind = ? AND period_review_case_id IS NULL AND model_task_id = ?
    ORDER BY id LIMIT 1`, [Number(strategyId), versionNo, contentHash, usageKind, taskId])
  if (existing) return existing
  const created = await createStrategyMemoryInjectionLog({ strategyId:Number(strategyId), actor,
    library, injectionKind:usageKind, modelTaskId:taskId })
  if (!created?.id) throw new Error('model_compare_memory_injection_log_failed')
  return created
}

function comparisonRatesEvidence(timeframe, rates = []) {
  const normalized = (Array.isArray(rates) ? rates : []).map(rate => ({
    time_utc_msc:compareRateUtcMs(rate),
    open:Number(rate?.open),
    high:Number(rate?.high),
    low:Number(rate?.low),
    close:Number(rate?.close),
    tick_volume:Number(rate?.tick_volume ?? rate?.volume ?? 0),
  }))
  return {
    timeframe,
    count:normalized.length,
    first_time_utc_msc:normalized[0]?.time_utc_msc || null,
    last_time_utc_msc:normalized.at(-1)?.time_utc_msc || null,
    sha256:comparisonFingerprint(normalized),
  }
}

function comparisonModelSnapshot(modelId, resolved) {
  const model = resolved.model || {}
  const runtime = {
    model_profile_id:Number(modelId),
    provider:model.provider || model.api_provider || null,
    model_name:model.model_name || null,
    api_base_url_sha256:comparisonFingerprint(model.api_base_url || ''),
    temperature:Number(model.temperature ?? 0.3),
    thinking_enabled:model.thinking_enabled !== 0 && model.thinking_enabled !== false,
    reasoning_effort:model.reasoning_effort || null,
    request_timeout_ms:Number(model.request_timeout_ms || 120000),
    credential_source:resolved.credential_source || null,
    profile_updated_at:model.profile_updated_at || null,
  }
  return { ...runtime, runtime_config_sha256:comparisonFingerprint(runtime) }
}

function compareRateUtcMs(rate) {
  const numeric = Number(rate?.time_utc_msc ?? rate?.time_msc)
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric
  const raw = String(rate?.time || '').trim()
  if (!raw) return null
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T')
  const parsed = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`)
  return Number.isFinite(parsed) ? parsed : null
}

function hydrateSnapshotMarket(sample) {
  const market = structuredClone(sample?.market_snapshot || {})
  const klines = sample?.klines && typeof sample.klines === 'object' ? sample.klines : {}
  market.strategy_context ||= {}
  market.strategy_context.timeframes ||= {}
  for (const [timeframe, rates] of Object.entries(klines)) {
    market.strategy_context.timeframes[timeframe] ||= {}
    market.strategy_context.timeframes[timeframe].klines = Array.isArray(rates) ? rates : []
  }
  market.strategy_context.visualization_klines = klines
  return market
}

function snapshotDecisionPoint(sample, evaluationTimeframe = 'M5', timezoneOffsetMinutes = 0) {
  const timeframe = String(evaluationTimeframe || 'M5').toUpperCase()
  const decisionUtcMs = compareJobUtcMs(sample?.signal_created_at)
  if (!Number.isFinite(decisionUtcMs) || decisionUtcMs <= 0) throw new Error('snapshot_compare_decision_time_missing')
  const durationMs = (TIMEFRAME_MINUTES[timeframe] || 5) * 60_000
  const shifted = decisionUtcMs + Number(timezoneOffsetMinutes || 0) * 60_000
  const outcomeOpenUtcMs = Math.ceil(shifted / durationMs) * durationMs
    - Number(timezoneOffsetMinutes || 0) * 60_000
  return { decisionUtcMs, outcomeOpenUtcMs, timeframe }
}

function snapshotTimeframes(samples = []) {
  if (!samples.length) return []
  const common = new Set(Object.keys(samples[0]?.klines || {}).map(item => String(item).toUpperCase()))
  for (const sample of samples.slice(1)) {
    const available = new Set(Object.keys(sample?.klines || {}).map(item => String(item).toUpperCase()))
    for (const timeframe of common) if (!available.has(timeframe)) common.delete(timeframe)
  }
  return [...common].filter(item => TIMEFRAME_MINUTES[item])
    .sort((a, b) => TIMEFRAME_MINUTES[a] - TIMEFRAME_MINUTES[b])
}

function resolveLockedSnapshotEvaluationTimeframe(snapshotRun) {
  return snapshotTimeframes(snapshotRun?.samples)[0] || null
}

function snapshotPrimaryTimeframe(snapshotRun, fallback = 'M5') {
  const market = snapshotRun?.samples?.[0]?.market_snapshot || {}
  const preferred = String(market.primary_timeframe || market.timeframe || fallback).toUpperCase()
  const available = snapshotTimeframes(snapshotRun?.samples)
  return available.includes(preferred) ? preferred : available[0] || preferred
}

function parseSnapshotPromptPayload(sample) {
  const raw = String(sample?.user_prompt || '').trim()
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first < 0 || last <= first) return null
  try { return JSON.parse(raw.slice(first, last + 1)) } catch { return null }
}

function snapshotPromptTimeframePlan(sample) {
  const payload = parseSnapshotPromptPayload(sample)
  const timeframes = payload?.strategy_context?.timeframes
    || payload?.market?.strategy_context?.timeframes
    || payload?.market_snapshot?.strategy_context?.timeframes
    || {}
  return Object.entries(timeframes).map(([timeframe, item]) => ({
    timeframe:String(timeframe).toUpperCase(),
    kline_count:Array.isArray(item?.klines) ? item.klines.length : 0,
  })).filter(item => TIMEFRAME_MINUTES[item.timeframe] && item.kline_count > 0)
}

function snapshotModelInputKlineCount(samples = []) {
  return samples.reduce((total, sample) => total + snapshotPromptTimeframePlan(sample)
    .reduce((sum, item) => sum + item.kline_count, 0), 0)
}

function snapshotAllowedEntryMethods(sample, fallback = []) {
  const prompt = String(sample?.system_prompt || '')
  const marker = prompt.lastIndexOf('entry_method')
  const fragment = marker >= 0 ? prompt.slice(marker, marker + 500) : ''
  const methods = ['market', 'limit', 'stop', 'stop_limit'].filter(method =>
    new RegExp(`(^|[^a-z_])${method}([^a-z_]|$)`, 'i').test(fragment))
  return methods.length ? methods : fallback
}

async function loadSnapshotOutcomeKline(userId, symbol, timeframe, outcomeOpenUtcMs) {
  const durationMs = (TIMEFRAME_MINUTES[timeframe] || 5) * 60_000
  const loaded = await loadPeriodMarketWindow(
    userId, symbol, timeframe, outcomeOpenUtcMs, outcomeOpenUtcMs + durationMs * 3,
    { alignToPeriodStart:false },
  )
  return (loaded.periodRates || []).find(rate => {
    const openUtcMs = compareRateUtcMs(rate)
    return openUtcMs != null && openUtcMs >= outcomeOpenUtcMs
  }) || null
}

function compareVisibleRates(rates, decisionUtcMs, timeframe, count, includeChan) {
  const durationMs = (TIMEFRAME_MINUTES[timeframe] || 1) * 60_000
  const closed = rates.filter(rate => {
    const openUtcMs = compareRateUtcMs(rate)
    return openUtcMs != null && openUtcMs + durationMs <= decisionUtcMs
  })
  const policy = includeChan ? getChanWindowPolicy(timeframe) : null
  const requested = Math.max(Number(count) || 100, policy?.target || 0)
  // Historical comparison is frozen to the same period-specific Chan target
  // used by live inference.  A strategy indicator may carry more history, but
  // it must not make Chan reintroduce the old 2000-bar window.
  return closed.slice(-requested)
}

function buildHistoryCompareSteps(klineCount, requestedSampleSize) {
  const first = HISTORY_COMPARE_MIN_CONTEXT - 1
  const last = klineCount - 2
  if (last < first) return []
  const available = last - first + 1
  const target = Math.min(available, Math.max(
    HISTORY_COMPARE_MIN_STEPS,
    Math.min(HISTORY_COMPARE_MAX_STEPS, Number(requestedSampleSize) || 12)
  ))
  if (target === 1) return [last]
  return [...new Set(Array.from({ length: target }, (_, index) =>
    Math.round(first + ((last - first) * index) / (target - 1))
  ))]
}

function buildContinuousHistoryCompareSteps(klineCount) {
  const count = Math.max(0, Number(klineCount) - 1)
  return Array.from({ length:count }, (_, index) => index)
}

export function resolveStrategyEvaluationTimeframe(strategy, planItems) {
  const configured = [...(planItems || [])]
    .filter(item => TIMEFRAME_MINUTES[item.timeframe])
    .sort((a, b) => TIMEFRAME_MINUTES[a.timeframe] - TIMEFRAME_MINUTES[b.timeframe])
  if (!configured.length) return null
  const intervalMinutes = Math.max(1, Number(strategy?.interval_minutes) || TIMEFRAME_MINUTES[configured[0].timeframe])
  const atOrBelow = configured.filter(item => TIMEFRAME_MINUTES[item.timeframe] <= intervalMinutes)
  return (atOrBelow.at(-1) || configured[0]).timeframe
}

function wilsonLowerBound(correct, total, z = 1.2815515655446004) {
  if (!total) return 0
  const p = correct / total
  const z2 = z * z
  return (p + z2 / (2 * total) - z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total))
    / (1 + z2 / total)
}

function historyExecutionWindows(modelSignals, endUtcMs, maxHoldingHours) {
  const horizonMs = Math.max(1, Number(maxHoldingHours) || 24) * 3_600_000
  const raw = Object.values(modelSignals || {}).flat()
    .filter(signal => signal.signal_type === 'buy' || signal.signal_type === 'sell')
    .map(signal => {
      const start = Number(signal.decision_time_utc_msc)
      if (!Number.isFinite(start)) return null
      const horizonEnd = start + horizonMs
      const boundedEnd = Math.min(endUtcMs, horizonEnd)
      // The range loader uses an exclusive end. Include the M1 candle whose
      // open time equals the holding horizon when it is still inside the
      // user-selected evaluation range, so horizon exits are not one minute early.
      const exclusiveEnd = boundedEnd < endUtcMs ? boundedEnd + 60_000 : boundedEnd
      return { start, end:exclusiveEnd }
    })
    .filter(window => window && window.end > window.start)
    .sort((a, b) => a.start - b.start)
  const merged = []
  for (const window of raw) {
    const previous = merged.at(-1)
    if (previous && window.start <= previous.end + 60_000) previous.end = Math.max(previous.end, window.end)
    else merged.push({ ...window })
  }
  return merged
}

async function loadHistoryExecutionCandles(userId, symbol, windows) {
  const timeframe = 'M1'
  const chunkMs = 4_500 * 60_000
  const merged = new Map()
  let marketSource = null
  let timezoneOffsetMinutes = null
  for (const window of windows || []) {
    for (let cursor = window.start; cursor < window.end; cursor += chunkMs) {
      const chunkEnd = Math.min(window.end, cursor + chunkMs)
      const loaded = await loadPeriodMarketWindow(userId, symbol, timeframe, cursor, chunkEnd, {
        alignToPeriodStart: false,
      })
      marketSource ||= loaded.marketMeta?.source || null
      if (timezoneOffsetMinutes == null && Number.isFinite(Number(loaded.marketMeta?.timezone_offset_minutes))) {
        timezoneOffsetMinutes = Number(loaded.marketMeta.timezone_offset_minutes)
      }
      for (const rate of loaded.periodRates || []) {
        const utcMs = compareRateUtcMs(rate)
        if (utcMs != null) merged.set(utcMs, { ...rate, time_utc_msc:utcMs })
      }
    }
  }
  return {
    timeframe,
    marketSource,
    timezoneOffsetMinutes,
    candles:[...merged.values()].sort((a, b) => Number(a.time_utc_msc) - Number(b.time_utc_msc)),
  }
}

async function loadHistorySymbolSnapshot(userId, symbol) {
  const lightweight = await mt5Bridge(userId, 'symbol_snapshot', { symbol }, {
    timeoutMs:10_000,
    noFallback:true,
  })
  if (lightweight?.status === 'success' && lightweight.instrument) return lightweight
  // Bridge versions released before account-replay-v1 do not know the
  // lightweight action. Reuse the existing compact risk snapshot once so the
  // feature works immediately; after the bridge is restarted, the normal path
  // above avoids positions/orders/history entirely.
  const legacy = await mt5Bridge(userId, 'risk_snapshot', {
    symbol,
    last_deal_time_msc:0,
    last_deal_ticket:0,
    baseline_from_utc_msc:Date.now(),
  }, { timeoutMs:10_000, noFallback:true })
  if (legacy?.status !== 'success') return legacy
  const instrument = Object.values(legacy.instruments || {}).find(item =>
    stripBrokerSuffix(item?.name || '').toUpperCase() === stripBrokerSuffix(symbol).toUpperCase())
  return { ...legacy, instrument:instrument || null, compatibility_fallback:true }
}

// Kept as a no-op test/reset hook for callers that used to clear the removed
// process-level sticky expansion map.
function clearChanHistoryHints() {}

export function resolveChanHistoryCount(userId, symbol, timeframe, requestedCount, useChan) {
  if (!useChan) return requestedCount
  const preferred = getChanWindowPolicy(timeframe).target
  return Math.max(requestedCount, preferred)
}

export function chanNeedsMoreHistory(chan) {
  if (!chan) return false
  const anchor = chan.structure_anchor || {}
  const trustedAnchorMatched = anchor.matched === true
    && Number(anchor.requested_time_utc_msc) > 0
  if (trustedAnchorMatched) return false
  // A missing center/entry/anchor is a structure state, not proof that more
  // historical candles are needed.  v6 reaches its fixed target once and
  // fails the relevant capability closed when evidence is unavailable.
  return chan.history_sufficient === false || chan.closed_history_sufficient === false
}

export function shouldPersistChanAnchor(useChan, chan, chanDataQuality) {
  const anchor = chan?.structure_anchor || {}
  const minimumHistory = Number(chan?.maximum_history_count) > 0
    ? Number(chan.maximum_history_count)
    : String(chan?.window_policy_version || '') === CHAN_WINDOW_POLICY_VERSION
      ? getChanWindowPolicy(chan?.timeframe).target
      : Number(chan?.source_history_count) || 0
  const structureTimeKeyReliable = chan?.structure_time_key_reliable === true
    || (chan?.structure_time_key_reliable == null && chan?.time_location_reliable === true)
  return Boolean(useChan && chan?.window_stable === true && Number(chan?.segment_count) >= 2
    && Number(chan?.source_history_count) >= minimumHistory
    && chan?.history_sufficient === true
    && chan?.closed_history_sufficient === true
    && structureTimeKeyReliable
    && chan?.cache_internal_gap_unresolved === false
    && chan?.reliability !== 'low'
    && chan?.authoritative_terminal_chain_confirmed === true
    && Number(anchor.recommended_time_utc_msc) > 0
    && anchor.full_window_authoritative === true
    && anchor.bootstrap_state === 'confirmed'
    && anchor.bootstrap_identity
    && anchor.bootstrap_core_stable_id
    && anchor.bootstrap_entry_segment_stable_id
    && Number(anchor.bootstrap_entry_start_time_utc_msc) === Number(anchor.recommended_time_utc_msc)
    && Number(anchor.last_confirmed_segment_time_utc_msc) >= Number(anchor.recommended_time_utc_msc)
    && Number(anchor.bootstrap_observation_time_utc_msc) >= Number(anchor.last_confirmed_segment_time_utc_msc)
    && Number(chan?.temporal_closed_bar_support) >= 3
    && Number(chan?.temporal_closed_bar_validator_count) >= 3
    && chan?.temporal_identity_stable === true
    && Number(chan?.cross_window_entry_support_count) >= 2
    && Number(chan?.cross_window_entry_support_count) * 2 > Number(chan?.cross_window_entry_validator_count)
    && Number(chanDataQuality?.source_id) > 0)
}

function snapshotContextHasChan(strategyContext) {
  if (!strategyContext || typeof strategyContext !== 'object') return false
  if (strategyContext.chan_timeframe_alignment || strategyContext.chan_structures) return true
  return Object.values(strategyContext.timeframes || {}).some(timeframe =>
    timeframe?.summary && typeof timeframe.summary === 'object' && timeframe.summary.chan != null)
}

function resolveSnapshotChanEnabled(samples) {
  return Array.isArray(samples) && samples.some(sample =>
    snapshotContextHasChan(sample?.market_snapshot?.strategy_context))
}

export const __strategyTest = {
  clearChanHistoryHints,
  snapshotContextHasChan, resolveSnapshotChanEnabled,
  buildAutoExecuteGuardRejection, resolveAutoExecuteGuard,
}

export async function attachAtrAnchor(userId, symbol, market, primaryTimeframe) {
  const timeframes = market.strategy_context?.timeframes || {}
  for (const tf of ATR_ANCHOR_PRIORITY) {
    const atr = Number(timeframes[tf]?.summary?.atr_14_closed)
    if (atr > 0) {
      market.atr_anchor = atr
      market.atr_anchor_tf = tf
      return market
    }
  }

  try {
    const response = await platformRates(userId, { symbol, timeframe: 'H1', count: 50 })
    const rates = response?.rates || []
    const closedRates = response?.market_meta?.last_bar_closed === true
      ? rates
      : rates.length > 1 ? rates.slice(0, -1) : []
    const atr = closedRates.length >= 15 ? computeAtr14(closedRates) : 0
    if (atr > 0) {
      market.atr_anchor = atr
      market.atr_anchor_tf = 'H1'
      return market
    }
  } catch (error) {
    console.warn(`[ATR Anchor] H1 fetch failed for ${symbol}: ${error.message}`)
  }

  market.atr_anchor = 0
  market.atr_anchor_tf = null
  console.warn(`[ATR Anchor] No closed hourly ATR available for ${symbol}`)
  return market
}

export async function buildStrategyContextFromTags(userId, symbol, account, positions, prompt, fallbackTimeframe, fallbackRates, mode = 'manual', marketDataPlan = null, useChanAnalysis = null, fallbackMarketMeta = null, compiledPolicy = null) {
  let tags = Array.isArray(marketDataPlan?.timeframes)
    ? marketDataPlan.timeframes.map(item => ({ tf: String(item.timeframe || '').toUpperCase(), count: Number(item.kline_count) || 100 }))
    : parseTimeframeTags(prompt, mode)
  if (tags.length === 0) {
    const tf = (fallbackTimeframe || 'M30').toUpperCase()
    const count = STRATEGY_TIMEFRAME_COUNTS[tf] || 100
    tags = [{ tf, count }]
  }
  const useChan = useChanAnalysis == null ? /\{\{USE_CHAN\}\}/.test(prompt) : Boolean(useChanAnalysis)
  const timeframes = {}
  const visualizationKlines = {}
  const policyIndicatorSources = {}
  const missingTimeframes = []
  for (const { tf, count } of tags) {
    const chanPolicy = useChan ? getChanWindowPolicy(tf) : null
    const chanEnabledForTimeframe = Boolean(useChan && chanPolicy?.supported !== false)
    const indicatorHistoryCount = Math.max(0, ...(compiledPolicy?.indicators || [])
      .filter(definition => definition.enabled && definition.source?.timeframe === tf)
      .map(indicatorRequiredHistory))
    const historyCount = Math.max(resolveChanHistoryCount(userId, symbol, tf, count, chanEnabledForTimeframe), indicatorHistoryCount)
    let rates
    let chanDataQuality = null
    if (tf === (fallbackTimeframe || '').toUpperCase() && fallbackRates && fallbackRates.length >= historyCount) {
      rates = fallbackRates
      chanDataQuality = fallbackMarketMeta
    } else {
      const resp = await platformRates(userId, { symbol, timeframe: tf, count: historyCount })
      rates = (resp && resp.rates) ? resp.rates : []
      chanDataQuality = resp?.market_meta || null
    }
    if (rates.length === 0) { missingTimeframes.push(tf); continue }
    let visibleRates = rates.slice(-count)
    let summary = calculateMarketData(symbol, tf, visibleRates, account, positions, {
      computeChan: chanEnabledForTimeframe,
      chanRates: rates,
      requestedChanHistoryCount: chanEnabledForTimeframe ? chanPolicy.target : null,
      chanMaximumHistoryCount: chanEnabledForTimeframe ? chanPolicy.maximumHistoryCount : null,
      chanValidationWindowCounts: chanEnabledForTimeframe ? chanPolicy.validationWindowCounts : null,
      chanWindowPolicyVersion: chanEnabledForTimeframe ? chanPolicy.windowPolicyVersion : null,
      chanDataQuality,
    })
    if (shouldPersistChanAnchor(chanEnabledForTimeframe, summary.chan, chanDataQuality)) {
      await saveChanStructureAnchor(chanDataQuality.source_id, symbol, tf, summary.chan.structure_anchor).catch(error => {
        console.warn(`[Chan] Failed to persist structure anchor for ${symbol} ${tf}: ${error.message}`)
      })
    }
    const { account: _acct, positions: _pos, symbol: _sym, timeframe: _tf, timestamp: _ts, ...slimSummary } = summary
    timeframes[tf] = {
      summary: slimSummary,
      klines: compactRates(visibleRates),
      ...(useChan && chanPolicy?.supported === false
        ? { chan_policy: { status:'unsupported', reason:chanPolicy.reason, timeframe:tf } }
        : {}),
    }
    policyIndicatorSources[tf] = {
      bars:compactRates(rates),
      lastBarClosed:typeof chanDataQuality?.last_bar_closed === 'boolean' ? chanDataQuality.last_bar_closed : null,
      internalGapUnresolved:chanDataQuality?.internal_gap_unresolved === true,
      marketSource:chanDataQuality?.source || chanDataQuality?.source_type || null,
    }
    if (chanEnabledForTimeframe) visualizationKlines[tf] = compactRates(rates.slice(-chanPolicy.target))
  }
  const context = {
    strategy_sequence: tags.map(t => `${t.tf}(${t.count})`).join(' → '),
    required_timeframes: tags.map(t => t.tf),
    used_timeframes: Object.keys(timeframes),
    missing_timeframes: missingTimeframes,
    context_status: missingTimeframes.length === 0 ? 'complete' : 'partial',
    timeframes,
  }
  // Snapshot-only evidence: keep it out of model payloads, ai_signals JSON and
  // ordinary WebSocket responses. prepareInferenceSnapshot reads it directly.
  if (useChan) Object.defineProperty(context, 'visualization_klines', { value: visualizationKlines, enumerable: false })
  Object.defineProperty(context, 'policyIndicatorSources', { value: policyIndicatorSources, enumerable: false })
  return context
}

export async function executeOrder(userId, config, request, action, options = {}) {
  return executeOrderCore(userId, config, request, action, options)
}

const AUTO_EXECUTE_GUARD_REQUIRED = 'manual_auto_execute_guard_required'
const AUTO_EXECUTE_GUARD_REJECTED = 'manual_auto_execute_guard_rejected'

export function buildAutoExecuteGuardRejection(error = null, fallbackCode = AUTO_EXECUTE_GUARD_REJECTED) {
  const rawCode = String(error?.code || error?.error_code || fallbackCode)
  const code = /^[a-z][a-z0-9_:-]{1,127}$/i.test(rawCode) ? rawCode : fallbackCode
  const message = code === 'manual_auto_execute_request_disconnected'
    ? '发起自动执行请求的浏览器连接已断开'
    : code === AUTO_EXECUTE_GUARD_REQUIRED
      ? '自动执行缺少请求授权'
      : '自动执行授权未通过'
  return { status:'rejected', error_code:code, message }
}

export async function resolveAutoExecuteGuard(guard, context = {}) {
  if (typeof guard !== 'function') return buildAutoExecuteGuardRejection(null, AUTO_EXECUTE_GUARD_REQUIRED)
  try {
    const decision = await guard(context)
    if (decision === true) return null
    return buildAutoExecuteGuardRejection(decision)
  } catch (error) {
    return buildAutoExecuteGuardRejection(error)
  }
}

export async function loadPrivatePortfolioContext(userId) {
  const [positionsData, pendingData] = await Promise.all([
    mt5Bridge(userId, 'positions', {}, { noFallback: true }),
    mt5Bridge(userId, 'pending_list', {}, { noFallback: true }),
  ])
  const pendingOrders = pendingData?.orders ?? pendingData?.pending_list
  if (!positionsData || positionsData.status === 'error' || !Array.isArray(positionsData.positions)
    || !pendingData || pendingData.status === 'error' || !Array.isArray(pendingOrders)) {
    throw new Error('private_portfolio_context_unavailable')
  }
  return { positions: positionsData.positions, pendingOrders }
}

export async function handleAnalyze(userId, params, options = {}) {
  const { session_id = 'default', symbol, strategy_id, auto_execute = false } = params
  if (!symbol) return { status: 'error', message: 'symbol required' }
  if (!strategy_id) return { status: 'error', message: 'strategy required' }

  const user = await queryOne('SELECT role FROM users WHERE id = ?', [userId])
  const strategy = await getStrategyById(Number(strategy_id), userId, user?.role || 'user', { forExecution: true })
  if (!strategy) return { status: 'error', message: 'strategy_not_available' }
  const supportedSymbols = new Set(parsePromptSymbols(strategy.symbols_json).map(item => stripBrokerSuffix(String(item)).toUpperCase()))
  if (!supportedSymbols.has(stripBrokerSuffix(symbol).toUpperCase())) return { status: 'error', message: 'symbol_not_supported_by_strategy' }
  const policy = parseStrategyPolicy(strategy)
  const config = await getAnalyzeApiKey(userId, session_id, Number(strategy.id))
  assertExpectedModelIdentity(config, options.expectedModelIdentity)
  config._allowed_entry_methods = policy.entryMethods
  config._market_data_plan = policy.marketDataPlan
  config._use_chan_analysis = policy.useChanAnalysis
  config._ai_volume_min = Number(config._ai_volume_min)
  config._ai_volume_max = Number(config._ai_volume_max)
  config._ai_volume_step = Number(config._ai_volume_step)
  config.enable_auto_trade = Boolean(auto_execute)
  config._market_only = strategy.scope === 'platform'
  config._include_portfolio_context = strategy.scope === 'private' && Boolean(Number(strategy.include_portfolio_context))
  if (options.abortSignal) config._abortSignal = options.abortSignal
  if (options.taskId) config._modelTaskId = String(options.taskId)
  if (Number(options.taskDeadlineAtUtcMs) > 0) config._taskDeadlineAtUtcMs = Number(options.taskDeadlineAtUtcMs)
  if (Number(options.resultValidUntilUtcMs) > 0) config._resultValidUntilUtcMs = Number(options.resultValidUntilUtcMs)
  if (typeof options.onProviderRequest === 'function') config._onProviderRequest = options.onProviderRequest
  if (typeof options.onProviderUsage === 'function') config._onProviderUsage = options.onProviderUsage
  if (typeof options.onProviderActivity === 'function') config._onProviderActivity = options.onProviderActivity
  if (typeof options.onProviderQuiet === 'function') config._onProviderQuiet = options.onProviderQuiet
  const onInferencePrepared = typeof options.onInferencePrepared === 'function'
    ? options.onInferencePrepared : null
  const prompt = strategy.system_prompt || ''
  const tags = policy.marketDataPlan.timeframes.map(item => ({ tf: item.timeframe, count: item.kline_count }))

  const account = null
  let positions = []
  let pendingOrders = []
  if (config._include_portfolio_context) {
    try {
      const portfolio = await loadPrivatePortfolioContext(userId)
      positions = portfolio.positions
      pendingOrders = portfolio.pendingOrders
    } catch (error) {
      console.error(`[Analyze] Private portfolio context unavailable for user ${userId}:`, error.message)
      return { status: 'error', message: '已开启持仓与挂单上下文，但当前无法从你的 MT5 获取完整数据，请确认桥接已连接后重试' }
    }
  }

  const primaryTf = policy.marketDataPlan.primary_timeframe || tags[0]?.tf || 'M30'
  const primaryTag = tags.find(item => item.tf === primaryTf) || tags[0]
  const primaryCount = primaryTag?.count || 100
  const primaryHistoryCount = resolveChanHistoryCount(userId, symbol, primaryTf, primaryCount, policy.useChanAnalysis)
  const ratesResp = await platformRates(userId, { symbol, timeframe: primaryTf, count: primaryHistoryCount })
  if (!ratesResp || ratesResp.status === 'error') return { status: 'error', message: 'Failed to get rates' }
  const rates = ratesResp.rates || []
  if (!Array.isArray(rates) || rates.length === 0) return { status: 'error', message: 'No rate data' }

  let market = calculateMarketData(symbol, primaryTf, rates.slice(-primaryCount), account, positions, { pending_orders: pendingOrders })
  const declaredPolicy = policy.policyMode === 'off' ? null : policy.compiledPolicy
  market.strategy_context = await buildStrategyContextFromTags(userId, symbol, account, positions, prompt, primaryTf, rates, 'manual', policy.marketDataPlan, policy.useChanAnalysis, ratesResp.market_meta, declaredPolicy)
  const strategyDataRuntime = prepareStrategyDataRuntime(policy, market.strategy_context, { rawPolicy:policy.strategyPolicy })
  if (strategyDataRuntime) market.strategy_context.indicators = strategyDataRuntime.indicators
  market.requested_timeframes = market.strategy_context.required_timeframes
  market.used_timeframes = market.strategy_context.used_timeframes
  market.missing_timeframes = market.strategy_context.missing_timeframes
  if (policy.useChanAnalysis) market.chan = market.strategy_context?.timeframes?.[primaryTf]?.summary?.chan
  await attachAtrAnchor(userId, symbol, market, primaryTf)
  if (!config._include_portfolio_context) {
    market = buildSharedMarketSnapshot(market, {
      standardSymbol: symbol,
      volumeMin: config._ai_volume_min,
      volumeMax: config._ai_volume_max,
      volumeStep: config._ai_volume_step,
      marketSource: ratesResp.market_meta?.source || 'platform_admin_bridge',
    })
  }
  let positionManagementContext = null
  try {
    positionManagementContext = await loadActivePositionManagementContext({
      strategyId:Number(strategy.id),
      strategyVersion:Number(strategy.version || 1),
      strategyScope:strategy.scope,
      ownerUserId:strategy.scope === 'private' ? userId : 0,
      symbol,
      market,
      decisionTimeframe:primaryTf,
    })
    if (hasActivePositionManagementGroups(positionManagementContext)
      && positionManagementContext.as_of.closed_bar_time_utc_ms) {
      config._positionManagementContext = positionManagementContext
    }
  } catch (error) {
    console.error('[Analyze] Position management context unavailable; continuing with new signal only:', error.message)
  }
  let memory = { contentText:'', versionNo:0, contentHash:null, logId:null }
  try {
    const resolvedMemory = await getStrategyMemoryLibraryForRuntime({ strategyId:Number(strategy.id), userId, role:'user' })
    const library = resolvedMemory.library
    const injection = await createStrategyMemoryInjectionLog({ strategyId:Number(strategy.id),
      actor:{ userId, role:'user' }, library, injectionKind:'manual_analysis', modelTaskId:options.taskId || null })
    memory = { contentText:library.content_text || '', versionNo:Number(library.version_no || 0),
      contentHash:library.content_hash || null, logId:injection.id }
  } catch (error) {
    console.error('[Analyze] Strategy memory library unavailable:', error.message)
    throw Object.assign(new Error('strategy_memory_library_unavailable'), { cause:error })
  }
  if (config) {
    config._strategyMemoryLibraryContext = memory.contentText
    config._strategyMemoryLibraryVersion = memory.versionNo
    config._strategyMemoryLibraryHash = memory.contentHash
    config._experienceSelection = { source:'strategy_library', selectedItemIds:[], selectedRefs:[], selectionDetails:[] }
    config._memoryMode = 'strategy_library'
  }
  let renderedEvidence = null
  if (config) config._onInferencePrepared = async evidence => {
    renderedEvidence = evidence
    await onInferencePrepared?.(evidence)
  }
  let signal
  try {
    signal = await maybeAiSignal(null, config, market, prompt)
  } finally {
    if (config) delete config._onInferencePrepared
  }
  market.inference_source = signal._inference_source || 'unknown'
  if (signal._inference_source === 'ai_error_hold') {
    return {
      status: 'error',
      error_code: 'ai_inference_failed',
      message: `AI 推理失败：${signal.reasoning || '模型未返回有效结果'}`,
    }
  }
  const modelSignalType = signal.signal_type
  delete signal._inference_source

  signal.decision_diagnostics = buildDecisionDiagnostics({ signal, market, modelSignalType })

  const createdAt = beijingNow()
  const createdAtUtcMsc = Date.now()
  const marketClock = trustedTerminalClock(ratesResp.market_meta || {}) ? ratesResp.market_meta : null
  const terminalOffsetMinutes = marketClock ? Math.trunc(Number(marketClock.timezone_offset_minutes)) : null
  const terminalClockStatus = marketClock ? String(marketClock.clock_status || '').trim().toLowerCase() : null
  const terminalClockSource = marketClock ? String(marketClock.clock_source || marketClock.source || 'market_snapshot') : null
  const marketJson = JSON.stringify(market)
  const decision = attachExecutionValidationToDecision(normalizeDecisionFields(signal), signal)
  const decisionJson = JSON.stringify(decision)
  const tokenCount = Math.round(((signal.analysis || '').length + (signal.reasoning || '').length + marketJson.length) / 4)
  if (!renderedEvidence) throw new Error('inference_evidence_missing')
  if (typeof options.assertCanApply === 'function') await options.assertCanApply()
  const persisted = await withTransaction(async run => {
    await options.assertCanApplyTx?.(run)
    const [result] = await run(`INSERT INTO ai_signals(user_id, prompt_type_id, source, session_id, symbol, timeframe, signal_type, confidence, recommended_volume,
      position_size_tier, position_size_factor, position_size_reason,
      analysis, reasoning, stop_loss_price, take_profit_1_price, take_profit_2_price, take_profit_3_price, recommended_take_profit_tier,
      market_data_json, token_count, ai_model, ttl_seconds, created_at,
      created_at_utc_msc, terminal_timezone_offset_minutes, terminal_clock_status, terminal_clock_source,
      entry_method, limit_price, stop_limit_price, pending_valid_until, schema_version, decision_json, inference_task_id)
      VALUES (?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
      [userId, Number(strategy.id), session_id, symbol, primaryTf, signal.signal_type, signal.confidence, signal.recommended_volume,
        signal.position_size_tier || null, signal.position_size_factor ?? null, signal.position_size_reason || null,
        signal.analysis, signal.reasoning, signal.stop_loss_price || null,
        signal.take_profit_1_price || null, signal.take_profit_2_price || null, signal.take_profit_3_price || null,
        signal.recommended_take_profit_tier || null,
        marketJson, tokenCount, (config || {}).model_name || 'deepseek-chat', signalTtlSeconds(primaryTf), createdAt,
        createdAtUtcMsc, terminalOffsetMinutes, terminalClockStatus, terminalClockSource,
        signal.entry_method || 'market', signal.limit_price || null, signal.stop_limit_price || null, signal.pending_valid_until || null,
        SIGNAL_SCHEMA_VERSION, decisionJson, options.taskId || null])
    const snapshotId = await persistInferenceSnapshotTx(run, {
      signalId: result.insertId, strategyId: Number(strategy.id), strategyVersion: Number(strategy.version || 1), strategyScope: strategy.scope, ownerUserId: Number(strategy.owner_user_id || 0),
      standardSymbol: stripBrokerSuffix(symbol).toUpperCase(), marketSource: ratesResp.market_meta?.source || 'platform_admin_bridge',
      systemPrompt: renderedEvidence.systemPrompt, userPrompt: renderedEvidence.userPrompt,
      outputSchemaVersion: renderedEvidence.outputSchemaVersion, marketSnapshot: market,
      modelProfileId: config?._model_profile_id, provider: config?.api_provider,
      modelName: config?.model_name, credentialSource: config?._credential_source,
      memoryMode:'strategy_library',
       strategyRuntime:buildStrategyRuntimeSnapshot({ strategy, policy, strategyDataRuntime, source:'manual' }), createdAt,
    })
    await createTradeThesisTx(run, {
      signalId:result.insertId,
      strategyId:Number(strategy.id),
      strategyVersion:Number(strategy.version || 1),
      strategyScope:strategy.scope,
      ownerUserId:Number(strategy.owner_user_id || 0),
      signal:{ ...signal, symbol },
      market,
      decisionTimeframe:primaryTf,
      modelProfileId:config?._model_profile_id,
      modelName:config?.model_name,
    })
    return { signalId: result.insertId, snapshotId }
  })

  signal.id = persisted.signalId
  if (signal._position_management && positionManagementContext) {
    try {
      await persistPositionManagementEvaluations({
        signalId:signal.id,
        context:positionManagementContext,
        management:signal._position_management,
        inferenceSource:'manual_analysis',
      })
    } catch (error) {
      console.error('[Analyze] Position management task persistence failed:', error.message)
      await insertAudit(null, userId, 'position_management_persist_failed', symbol,
        { signal_id:signal.id, strategy_id:Number(strategy.id) },
        { status:'error', message:error.message }, 'error')
    }
  }
  if (memory.logId) try {
    await updateStrategyMemoryInjectionLog(memory.logId, { signalId:signal.id,
      inferenceSnapshotId:persisted.snapshotId, modelTaskId:options.taskId || null })
  } catch (error) { console.error('[Analyze] Strategy memory attribution failed:', error.message) }
  signal.symbol = symbol
  signal.user_id = userId
  signal.timeframe = primaryTf
  signal.created_at = createdAt
  signal.created_at_utc_msc = createdAtUtcMsc
  signal.terminal_timezone_offset_minutes = terminalOffsetMinutes
  signal.terminal_clock_status = terminalClockStatus
  signal.terminal_clock_source = terminalClockSource
  signal.market_data = market
  signal.is_executed = false
  attachSignalTiming(signal)
  signal = attachSignalPresentation({ ...signal, ...decision, decision_json: decisionJson })

  // Push new signal notification to browser
  sendToBrowsers(userId, {
    type: 'new_signal',
    signal_id: signal.id,
    signal_type: signal.signal_type,
    symbol: signal.symbol,
    timeframe: signal.timeframe,
    confidence: signal.confidence,
    created_at: createdAt
  })

  if (signal.signal_type !== 'hold' && config && config.enable_auto_trade) {
    const executionValidation = readExecutionValidation(signal)
    if (executionValidation.validation.eligible !== true) {
      const rejection = executionValidationRejection(executionValidation)
      signal.execution_result = rejection
      await queryRun('UPDATE ai_signals SET execution_result = ? WHERE id = ?', [JSON.stringify(rejection), signal.id])
      await insertAudit(null, userId, 'ai_execute', signal.symbol,
        { signal_id:signal.id, source:'analyze_auto', reason:rejection.error_code }, rejection, 'rejected')
      sendToBrowsers(userId, { type:'signal_execution_updated', signal_id:signal.id, status:'rejected' })
    } else {
      const guardRejection = await resolveAutoExecuteGuard(options.assertAutoExecute, {
        userId, signal, market,
      })
      if (guardRejection) {
        signal.execution_result = guardRejection
        await queryRun('UPDATE ai_signals SET execution_result = ? WHERE id = ?', [JSON.stringify(guardRejection), signal.id])
        await insertAudit(null, userId, 'ai_execute', signal.symbol,
          { signal_id:signal.id, source:'analyze_auto', reason:guardRejection.error_code },
          guardRejection, 'rejected')
        sendToBrowsers(userId, { type: 'signal_execution_updated', signal_id: signal.id, status: 'rejected' })
      } else if (!isTradeEnabled(userId)) {
        console.log(`[Analyze] Auto-execute blocked: trade_send_enabled=0`)
        await insertAudit(null, userId, 'ai_execute', signal.symbol, { signal_id: signal.id, source: 'analyze_auto', reason: 'trade_send_disabled' }, { status: 'rejected', message: '交易发送已关闭' }, 'rejected')
        signal.execution_result = { status: 'rejected', message: '交易发送已关闭' }
        await queryRun('UPDATE ai_signals SET execution_result = ? WHERE id = ?', [JSON.stringify(signal.execution_result), signal.id])
        sendToBrowsers(userId, { type: 'signal_execution_updated', signal_id: signal.id, status: 'rejected' })
      } else {
        try {
          const riskCfg = {
            enable_auto_trade: true,
            take_profit_mode: 'ai_recommended',
            max_position_size: config.max_position_size ?? DEFAULT_MAX_POSITION_SIZE,
          }
          const orderPayload = signalOrderPayload(signal, riskCfg, market, true)
          const assertAutoExecuteBeforeSend = async () => {
            const rejection = await resolveAutoExecuteGuard(options.assertAutoExecute, {
              userId, signal, market,
            })
            if (rejection) throw Object.assign(new Error(rejection.error_code), {
              code:rejection.error_code,
            })
            return true
          }

          const execResult = await executeOrder(userId, riskCfg, orderPayload, 'ai_execute', {
            sourceType:'manual_ai',
            beforeBridgeSend:assertAutoExecuteBeforeSend,
            beforeWrite:assertAutoExecuteBeforeSend,
          })
          signal.execution_result = execResult
          await queryRun('UPDATE ai_signals SET execution_result = ? WHERE id = ?', [JSON.stringify(execResult || {}), signal.id])
          if (execResult && execResult.status === 'success') {
            const isPending = orderPayload.entry_method && orderPayload.entry_method !== 'market' && orderPayload.entry_method !== 'observe'
            const ticket = isPending
              ? (execResult.order || execResult.pending_ticket || execResult.ticket || null)
              : (execResult.position_id || execResult.position || execResult.trade_ticket || execResult.ticket || execResult.order || null)
            if (isPending) {
              const pendingState = ['pending', 'partially_filled', 'filled', 'cancelled', 'expired']
                .includes(String(execResult.pending_state || '').toLowerCase())
                ? String(execResult.pending_state).toLowerCase() : 'pending'
              const pendingExecuted = ['partially_filled', 'filled'].includes(pendingState)
              await queryRun(`UPDATE ai_signals SET pending_ticket = ?, pending_state = ?, is_executed = ?,
                executed_at = CASE WHEN ? = 1 THEN COALESCE(executed_at, ?) ELSE executed_at END WHERE id = ?`,
              [String(ticket), pendingState, pendingExecuted ? 1 : 0, pendingExecuted ? 1 : 0, beijingNow(), signal.id])
              signal.pending_ticket = String(ticket)
              signal.pending_state = pendingState
              signal.is_executed = pendingExecuted
              if (pendingExecuted && !signal.executed_at) signal.executed_at = beijingNow()
            } else {
              await queryRun('UPDATE ai_signals SET is_executed = 1, executed_at = ?, trade_ticket = ? WHERE id = ?',
                [beijingNow(), ticket, signal.id])
              signal.is_executed = true
              signal.executed_at = beijingNow()
              signal.trade_ticket = ticket
            }
            signal.auto_executed = true
            sendToBrowsers(userId, {
              type: 'signal_execution_updated', signal_id: signal.id, status: 'success',
              pending_ticket: isPending ? String(ticket) : null, trade_ticket: isPending ? null : ticket,
            })
          } else {
            const executionStatus = execResult?.status === 'rejected'
              ? 'rejected'
              : execResult?.status === 'uncertain' ? 'uncertain' : 'failed'
            sendToBrowsers(userId, { type: 'signal_execution_updated', signal_id: signal.id, status: executionStatus })
          }
          await insertAudit(null, userId, 'ai_execute', signal.symbol, { signal_id: signal.id, source: 'analyze_auto', tp_tier_requested: orderPayload.tp_tier_requested, tp_tier_used: orderPayload.tp_tier_used, normalization_info: orderPayload.normalization_info }, execResult, execResult?.status || 'error')
        } catch (e) {
          console.error('[Analyze] Auto-execute failed:', e.message)
          signal.execution_result = { status: 'error', message: e.message || '自动执行失败' }
          await queryRun('UPDATE ai_signals SET execution_result = ? WHERE id = ?', [JSON.stringify(signal.execution_result), signal.id])
          sendToBrowsers(userId, { type: 'signal_execution_updated', signal_id: signal.id, status: 'failed' })
        }
      }
    }
  }

  signal = attachSignalPresentation(signal)
  return { status: 'success', signal, market }
}

async function executeAnalyzeCompare(userId, params, options = {}) {
  const { symbol, model_ids, strategy_id } = params
  const jobId = String(options.jobId || liveCompareJobId(liveCompareIdempotency(userId, params)))
  if (!symbol) return { status: 'error', message: 'symbol required' }
  if (!strategy_id) return { ok: false, error: 'strategy_id_required' }
  if (!Array.isArray(model_ids) || model_ids.length < 2 || model_ids.length > 5) {
    return { status: 'error', message: 'model_ids must be an array of 2-5 model profile IDs' }
  }

  const uniqueIds = [...new Set(model_ids.map(Number))]
  if (uniqueIds.length < 2 || uniqueIds.length > 5) {
    return { status: 'error', message: 'model_ids must contain 2-5 unique IDs' }
  }
  const actor = await queryOne('SELECT role FROM users WHERE id = ?', [userId])
  const modelOwnerId = actor?.role === 'admin' ? 0 : userId

  const strategy = await getStrategyById(Number(strategy_id), userId, actor?.role || 'user', { forExecution: false })
  if (!strategy) return { ok: false, error: 'strategy_not_found' }

  let compareMemory
  try {
    const resolvedMemory = await getStrategyMemoryLibraryForRuntime({ strategyId:Number(strategy.id),
      userId, role:actor?.role || 'user' })
    compareMemory = compareMemoryIdentity(resolvedMemory?.library, {
      missingCode:'strategy_memory_library_unavailable',
      invalidCode:'strategy_memory_library_unavailable',
    })
  } catch (error) {
    console.error('[AnalyzeCompare] Strategy memory library unavailable:', error.message)
    return { ok:false, error:error?.code === 'history_compare_memory_snapshot_invalid'
      ? 'history_compare_memory_snapshot_invalid' : 'strategy_memory_library_unavailable' }
  }

  const supportedSymbols = new Set(parsePromptSymbols(strategy.symbols_json).map(item => stripBrokerSuffix(String(item)).toUpperCase()))
  if (!supportedSymbols.has(stripBrokerSuffix(symbol).toUpperCase())) return { ok: false, error: 'symbol_not_supported_by_strategy' }

  const prompt = strategy.system_prompt || ''
  const policy = parseStrategyPolicy(strategy)
  const aiVolumeRange = await resolvePlatformAiVolumeRange()
  const primaryTf = policy.marketDataPlan?.primary_timeframe || 'M30'
  const tags = (policy.marketDataPlan?.timeframes || []).map(item => ({ tf: item.timeframe, count: item.kline_count }))
  if (tags.length === 0) tags.push({ tf: primaryTf, count: 100 })
  const primaryTag = tags.find(item => item.tf === primaryTf) || tags[0]
  const primaryCount = primaryTag?.count || 100
  const primaryHistoryCount = resolveChanHistoryCount(userId, symbol, primaryTf, primaryCount, policy.useChanAnalysis)

  const ratesResp = await platformRates(userId, { symbol, timeframe: primaryTf, count: primaryHistoryCount })
  if (!ratesResp || ratesResp.status === 'error') return { status: 'error', message: 'Failed to get rates' }
  const rates = ratesResp.rates || []
  if (!Array.isArray(rates) || rates.length === 0) return { status: 'error', message: 'No rate data' }

  let market = calculateMarketData(symbol, primaryTf, rates.slice(-primaryCount), null, [], {})
  const declaredPolicy = policy.policyMode === 'off' ? null : policy.compiledPolicy
  market.strategy_context = await buildStrategyContextFromTags(userId, symbol, null, [], prompt, primaryTf, rates, 'manual', policy.marketDataPlan, policy.useChanAnalysis, ratesResp.market_meta, declaredPolicy)
  const baseStrategyDataRuntime = prepareStrategyDataRuntime(policy, market.strategy_context, { rawPolicy:policy.strategyPolicy })
  if (baseStrategyDataRuntime) market.strategy_context.indicators = baseStrategyDataRuntime.indicators
  market.requested_timeframes = market.strategy_context.required_timeframes
  market.used_timeframes = market.strategy_context.used_timeframes
  market.missing_timeframes = market.strategy_context.missing_timeframes
  await attachAtrAnchor(userId, symbol, market, primaryTf)
  if (strategy.scope === 'platform') {
    market = buildSharedMarketSnapshot(market, {
      standardSymbol: symbol,
      volumeMin: aiVolumeRange.min,
      volumeMax: aiVolumeRange.max,
      volumeStep: aiVolumeRange.step,
      marketSource: ratesResp.market_meta?.source || 'platform_admin_bridge',
    })
  }

  const profileResults = await Promise.allSettled(
    uniqueIds.map(async (modelId) => {
      const resolved = await resolveOwnedModelProfileForRuntime(modelId, modelOwnerId)
      if (!resolved.model || !resolved.model.api_key_encrypted) {
        throw new Error(resolved.error || 'model_profile_not_found_or_inactive')
      }
      return { modelId, resolved }
    })
  )

  const validModels = []
  const results = []
  for (let i = 0; i < uniqueIds.length; i++) {
    const profileResult = profileResults[i]
    const modelId = uniqueIds[i]
    if (profileResult.status === 'rejected' || !profileResult.value) {
      results.push({ model_id: modelId, status: 'error', error: profileResult.reason?.message || 'model_profile_resolution_failed' })
    } else {
      validModels.push(profileResult.value)
    }
  }

  const liveMarketEvidenceHash = comparisonFingerprint({
    symbol,
    timeframe:primaryTf,
    rates,
    market_meta:ratesResp.market_meta || null,
    market,
  })
  const liveCompareCheckpointContext = {
    strategyFingerprint:comparisonFingerprint({
      strategy_id:Number(strategy.id), strategy_version:Number(strategy.version || 1),
      scope:strategy.scope || null, policy:policy.compiledPolicy || policy,
    }),
    promptHash:comparisonFingerprint(prompt),
    snapshotFingerprint:liveMarketEvidenceHash,
    outputContractHash:comparisonFingerprint('ai_signal_compare_v1'),
    marketEvidenceHash:liveMarketEvidenceHash,
  }

  const liveBatchAbortController = new AbortController()
  const liveTrackers = new Set()
  const inferenceTaskPromises = validModels.map(async ({ modelId, resolved }, modelIndex) => {
    const config = {
      ...resolved.model,
      system_prompt: prompt,
      _userId: userId,
      _usage: 'model_compare',
      _strategyId:Number(strategy.id),
      _model_shared: resolved.credential_source === 'platform_shared',
      _model_profile_id: resolved.model_profile_id,
      _credential_source: resolved.credential_source,
      _allowed_entry_methods: policy.entryMethods,
      _market_data_plan: policy.marketDataPlan,
      _use_chan_analysis: policy.useChanAnalysis,
      _market_only: strategy.scope === 'platform',
      _ai_volume_min: aiVolumeRange.min,
      _ai_volume_max: aiVolumeRange.max,
      _ai_volume_step: aiVolumeRange.step,
      _comparison_mode:true,
      _strategyMemoryLibraryContext:compareMemory.content_text || '',
      _strategyMemoryLibraryVersion:Number(compareMemory.version_no || 0),
      _strategyMemoryLibraryHash:compareMemory.content_hash || null,
      _memoryMode:'strategy_library',
      _experienceSelection:{ source:'strategy_library', selectedItemIds:[], selectedRefs:[], selectionDetails:[] },
    }
    const strategyDataRuntime = baseStrategyDataRuntime ? structuredClone(baseStrategyDataRuntime) : null
    const unitKey = `live:${modelId}`
    const taskEnvelope = compareUnitTaskInput({
      userId, strategy, config, jobId, mode:'live', unitKey, modelId,
      promptHash:liveCompareCheckpointContext.promptHash,
      snapshotHash:liveCompareCheckpointContext.snapshotFingerprint,
      outputContractHash:liveCompareCheckpointContext.outputContractHash,
      marketEvidenceHash:liveCompareCheckpointContext.marketEvidenceHash,
      decisionUtcMs:Date.now(), strategyMemory:compareMemory, strategyDataRuntime,
    })
    let tracker = null
    let restoreCallbacks = null
    let preparedEvidence = null
    const checkpointBase = {
      model_id:Number(modelId), unit_key:unitKey, unit_index:modelIndex,
      decision_time_utc_msc:Date.now(), outcome_time_utc_msc:null, snapshot_id:null,
      strategy_fingerprint:liveCompareCheckpointContext.strategyFingerprint,
      prompt_hash:liveCompareCheckpointContext.promptHash,
      snapshot_fingerprint:liveCompareCheckpointContext.snapshotFingerprint,
      model_config_fingerprint:taskEnvelope.modelConfigFingerprint,
      output_contract_hash:liveCompareCheckpointContext.outputContractHash,
      market_evidence_hash:liveCompareCheckpointContext.marketEvidenceHash,
    }
    try {
      await persistHistoryCompareCheckpoint(jobId, {
        ...checkpointBase, checkpoint_status:'submitting', telemetry:{},
      })
      if (liveBatchAbortController.signal.aborted) {
        throw liveBatchAbortController.signal.reason || new Error('model_compare_batch_aborted')
      }
      try {
        tracker = await createModelTaskTracker(taskEnvelope.input, {
          workerId:`model-compare:${jobId}:${unitKey}`,
        })
      } catch (error) {
        const duplicate = /model_task_duplicate_(active|terminal)/.test(String(error?.code || error?.message || ''))
        if (duplicate) {
          const existingTask = await loadCompareTaskByIdempotency(taskEnvelope.input)
          await persistHistoryCompareCheckpoint(jobId, {
            ...checkpointBase, checkpoint_status:'submitting',
            telemetry:{ model_task_id:existingTask?.task_id || null },
          })
          return { model_id:modelId, status:'status_unknown', error:'model_compare_status_unknown',
            model_task_id:existingTask?.task_id || null }
        }
        throw error
      }
      liveTrackers.add(tracker)
      await ensureCompareStrategyMemoryInjectionLog({ strategyId:Number(strategy.id),
        actor:{ userId, role:actor?.role || 'user' }, library:compareMemory,
        modelTaskId:tracker.taskId, usageKind:'model_compare_live' })
      if (liveBatchAbortController.signal.aborted) {
        throw liveBatchAbortController.signal.reason || new Error('model_compare_batch_aborted')
      }
      restoreCallbacks = installCompareTrackerCallbacks(config, tracker, {
        abortSignal:liveBatchAbortController.signal,
        taskDeadlineAtUtcMs:taskEnvelope.deadlines.attemptSafetyDeadlineUtcMs,
        resultValidUntilUtcMs:taskEnvelope.deadlines.attemptSafetyDeadlineUtcMs,
        onInferencePrepared:evidence => {
          preparedEvidence = {
            system_prompt_sha256:comparisonFingerprint(evidence?.systemPrompt || ''),
            user_prompt_sha256:comparisonFingerprint(evidence?.userPrompt || ''),
            output_schema_version:evidence?.outputSchemaVersion || null,
          }
        },
      })
      await persistHistoryCompareCheckpoint(jobId, {
        ...checkpointBase,
        checkpoint_status:'submitting',
        telemetry:{ model_task_id:tracker.taskId },
      })
      let signal = await maybeAiSignal(null, config, market, prompt)
      const modelSignalType = signal.signal_type
      const inferenceSource = signal?._inference_source || 'unknown'
      if (inferenceSource !== 'ai') {
        const error = new Error(signal?.reasoning || 'inference_failed')
        error.code = 'model_compare_inference_failed'
        throw error
      }
      delete signal._inference_source
      signal.decision_diagnostics = buildDecisionDiagnostics({ signal, market, modelSignalType })
      const profile = resolved.model
      const result = {
        model_id: modelId,
        model_name: profile.model_name,
        provider: profile.provider || profile.api_provider,
        status: 'success',
        signal,
        signal_type: signal.signal_type,
        confidence: signal.confidence,
        analysis: signal.analysis,
        reasoning: signal.reasoning,
        latest_price: market.latest_price,
        strategy_data_runtime:strategyDataRuntime,
      }
      await tracker.resultReady({ resultRef:`model_compare:${jobId}:${unitKey}`, resultHash:comparisonFingerprint(result) })
      await tracker.applying()
      await persistHistoryCompareCheckpoint(jobId, {
        ...checkpointBase,
        checkpoint_status:'completed',
        result:result.signal,
        telemetry:{ model_task_id:tracker.taskId },
        input_evidence:preparedEvidence,
      })
      await tracker.succeeded({ resultRef:`model_compare:${jobId}:${unitKey}`, resultHash:comparisonFingerprint(result) })
      return result
    } catch (error) {
      if (compareTrackerIsUnknown(tracker, error)) {
        return { model_id:modelId, status:'status_unknown', error:'model_compare_status_unknown', model_task_id:tracker?.taskId || null }
      }
      if (!tracker) throw error
      if (tracker) {
        try {
          await tracker.failed(error, true)
          if (compareTrackerIsUnknown(tracker, error)) {
            return { model_id:modelId, status:'status_unknown', error:'model_compare_status_unknown', model_task_id:tracker.taskId }
          }
          if (['failed_terminal', 'completed_rejected'].includes(String(tracker.status || ''))) {
            await persistHistoryCompareCheckpoint(jobId, {
              ...checkpointBase,
              checkpoint_status:'failed', error_code:error.code || error.message || 'inference_failed',
              result:{ signal_type:'error', error:error.message || 'inference_failed' },
              telemetry:{ model_task_id:tracker.taskId }, input_evidence:preparedEvidence,
            })
          }
        } catch (transitionError) {
          if (compareTrackerIsUnknown(tracker, transitionError)) {
            return { model_id:modelId, status:'status_unknown', error:'model_compare_status_unknown', model_task_id:tracker.taskId }
          }
        }
      }
      return { model_id:modelId, status:'error', error:error.message || 'inference_failed' }
    } finally {
      restoreCallbacks?.()
      await tracker?.stop?.().catch(() => {})
    }
  })

  const inferenceTasks = inferenceTaskPromises.map(task => task.catch(error => {
    if (!liveBatchAbortController.signal.aborted) liveBatchAbortController.abort(error)
    throw error
  }))
  const settledInference = await Promise.allSettled(inferenceTasks)
  const rejectedInference = settledInference.find(item => item.status === 'rejected')
  if (rejectedInference) {
    if (!liveBatchAbortController.signal.aborted) liveBatchAbortController.abort(rejectedInference.reason)
    await Promise.allSettled([...liveTrackers].map(async tracker => {
      if (['result_ready', 'applying'].includes(String(tracker.status || ''))) {
        await tracker.completedStale('model_compare_peer_rejected').catch(() => {})
      }
      await tracker.stop?.().catch(() => {})
    }))
    throw rejectedInference.reason
  }
  const inferenceResults = settledInference.map(item => item.value)
  for (const r of inferenceResults) {
    results.push(r)
  }

  if (inferenceResults.some(result => result?.status === 'status_unknown')) {
    return { ok:false, status:'status_unknown', error:'model_compare_status_unknown', job_id:jobId }
  }

  const models = Object.fromEntries(validModels.map(({ modelId, resolved }) => [modelId, {
    model_name: resolved.model.model_name,
    provider: resolved.model.provider || resolved.model.api_provider,
  }]))
  return { ok: true, results, models, market_snapshot: market }
}

function liveCompareIdempotency(userId, params = {}, nowMs = Date.now()) {
  const explicit = String(params.idempotency_key || params.request_id || '').trim()
  const source = explicit || JSON.stringify({
    window:Math.floor(Number(nowMs) / (10 * 60_000)),
    user_id:Number(userId), strategy_id:Number(params.strategy_id || 0),
    symbol:String(params.symbol || '').toUpperCase(),
    model_ids:Array.isArray(params.model_ids) ? [...new Set(params.model_ids.map(Number))].sort((a, b) => a - b) : [],
  })
  return crypto.createHash('sha256').update(`live-model-compare:${Number(userId)}:${source}`).digest('hex')
}

function liveCompareSourceHash(userId, params = {}) {
  return crypto.createHash('sha256').update(JSON.stringify({
    user_id:Number(userId), strategy_id:Number(params.strategy_id || 0),
    symbol:String(params.symbol || '').toUpperCase(),
    model_ids:Array.isArray(params.model_ids) ? [...new Set(params.model_ids.map(Number))].sort((a, b) => a - b) : [],
  })).digest('hex')
}

function liveCompareJobId(idempotencyHash) {
  const value = String(idempotencyHash || '').padEnd(32, '0')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`
}

function mergeCompareAbortSignals(...signals) {
  const active = signals.filter(Boolean)
  if (active.length <= 1) return active[0] || null
  if (typeof AbortSignal?.any === 'function') return AbortSignal.any(active)
  const controller = new AbortController()
  const abort = event => {
    if (!controller.signal.aborted) controller.abort(event?.target?.reason)
  }
  active.forEach(signal => {
    if (signal.aborted) abort({ target: signal })
    else signal.addEventListener('abort', abort, { once:true })
  })
  return controller.signal
}

function compareUnitIdempotencyKey({ jobId, mode, unitKey, modelId, inputHash, modelConfigFingerprint }) {
  // Keep the durable key below the historical VARCHAR(191) limit while
  // retaining every source component in the hashed payload.
  const source = [String(jobId), String(mode), String(unitKey), Number(modelId), String(inputHash || ''),
    String(modelConfigFingerprint || '')].join(':')
  return `mc:${comparisonFingerprint(source)}`
}

function compareUnitTaskInput({ userId, strategy, config, jobId, mode, unitKey, modelId,
  inputHash, promptHash, snapshotHash, outputContractHash, marketEvidenceHash,
  decisionUtcMs, resultValidUntilUtcMs = null, strategyMemory = null, strategyDataRuntime = null }) {
  const nowUtcMs = Date.now()
  const deadlines = modelTaskDeadlines('model_compare', { nowUtcMs })
  const modelConfigFingerprint = comparisonFingerprint({
    model_profile_id:Number(config?._model_profile_id || modelId),
    provider:config?.provider || config?.api_provider || null,
    model_name:config?.model_name || null,
    api_base_url_sha256:comparisonFingerprint(config?.api_base_url || ''),
    protocol:config?.protocol || config?._protocol || 'chat_completions',
    credential_source:config?._credential_source || null,
    temperature:Number(config?.temperature ?? 0.3),
    thinking_enabled:config?.thinking_enabled !== 0 && config?.thinking_enabled !== false,
    reasoning_effort:config?.reasoning_effort || null,
  })
  const sourceHash = inputHash || comparisonFingerprint({ jobId, mode, unitKey, modelId,
    promptHash, modelConfigFingerprint, snapshotHash, marketEvidenceHash,
    memory_library_version_no:strategyMemory?.version_no ?? null,
    memory_library_content_hash:strategyMemory?.content_hash || null,
    strategy_data_runtime_version:strategyDataRuntime?.data_runtime_version || null,
    strategy_policy_hash:strategyDataRuntime?.policy_hash || null,
    indicator_evidence_hashes:strategyDataRuntime?.indicator_evidence_hashes
      || strategyDataRuntime?.audit_identity?.indicator_evidence_hashes || {} })
  return {
    modelConfigFingerprint,
    deadlines,
    input: {
      taskKind:'model_compare',
      queueClass:'background',
      ownerUserId:Number(userId) || 0,
      strategyId:Number(strategy?.id) || null,
      domainType:'model_compare_unit',
      domainId:`${String(jobId)}:${String(mode)}:${String(unitKey)}:${Number(modelId)}`,
      idempotencyKey:compareUnitIdempotencyKey({
        jobId, mode, unitKey, modelId, inputHash:sourceHash, modelConfigFingerprint,
      }),
      snapshotHash:snapshotHash || null,
      inputHash:sourceHash,
      promptHash:promptHash || null,
      outputContractHash:outputContractHash || null,
      provider:config?.provider || config?.api_provider || null,
      model:config?.model_name || null,
      modelProfileId:Number(config?._model_profile_id || modelId) || null,
      protocol:config?.protocol || config?._protocol || 'chat_completions',
      credentialSource:config?._credential_source || null,
      frozenContext:{
        compare_job_id:String(jobId), compare_mode:String(mode), unit_key:String(unitKey),
        model_id:Number(modelId), decision_time_utc_msc:Number(decisionUtcMs) || null,
        input_hash:sourceHash, prompt_hash:promptHash || null,
        snapshot_hash:snapshotHash || null, market_evidence_hash:marketEvidenceHash || null,
        ...(strategyMemory ? {
          memory_library_version_no:Number(strategyMemory.version_no || 0),
          memory_library_content_hash:strategyMemory.content_hash || null,
        } : {}),
        strategy_data_runtime_version:strategyDataRuntime?.data_runtime_version || null,
        strategy_policy_hash:strategyDataRuntime?.policy_hash || null,
        indicator_evidence_hashes:strategyDataRuntime?.indicator_evidence_hashes
          || strategyDataRuntime?.audit_identity?.indicator_evidence_hashes || {},
      },
      scheduledAtUtcMs:nowUtcMs,
      // The generic task envelope retains the longer task deadline. The LLM
      // request itself receives the per-attempt safety deadline below.
      taskDeadlineAtUtcMs:deadlines.taskDeadlineUtcMs,
      resultValidUntilUtcMs:Number(resultValidUntilUtcMs) || deadlines.taskDeadlineUtcMs,
      maxAttempts:1,
    },
  }
}

function installCompareTrackerCallbacks(config, tracker, {
  abortSignal = null, onProviderRequest = null, onProviderUsage = null,
  onProviderActivity = null, onProviderQuiet = null, onInferencePrepared = null,
  taskDeadlineAtUtcMs = null, resultValidUntilUtcMs = null,
} = {}) {
  const previous = {
    onProviderRequest:config._onProviderRequest,
    onProviderUsage:config._onProviderUsage,
    onProviderActivity:config._onProviderActivity,
    onProviderQuiet:config._onProviderQuiet,
    onInferencePrepared:config._onInferencePrepared,
    abortSignal:config._abortSignal || null,
  }
  config._modelTaskId = tracker.taskId
  config._taskDeadlineAtUtcMs = Number(taskDeadlineAtUtcMs)
    || Number(tracker.task?.task_deadline_at_utc_msc) || null
  config._resultValidUntilUtcMs = Number(resultValidUntilUtcMs)
    || Number(tracker.task?.result_valid_until_utc_msc) || null
  config._abortSignal = mergeCompareAbortSignals(previous.abortSignal, abortSignal, tracker.signal)
  config._onProviderRequest = async event => {
    await tracker.onProviderRequest(event)
    await previous.onProviderRequest?.(event)
    await onProviderRequest?.(event)
  }
  config._onProviderUsage = async event => {
    await tracker.onProviderUsage(event)
    await previous.onProviderUsage?.(event)
    await onProviderUsage?.(event)
  }
  config._onProviderActivity = async event => {
    await tracker.onProviderActivity(event)
    await previous.onProviderActivity?.(event)
    await onProviderActivity?.(event)
  }
  config._onProviderQuiet = async event => {
    await tracker.onProviderQuiet(event)
    await previous.onProviderQuiet?.(event)
    await onProviderQuiet?.(event)
  }
  config._onInferencePrepared = async evidence => {
    await tracker.persistBudget(evidence?.modelTaskBudget)
    await previous.onInferencePrepared?.(evidence)
    await onInferencePrepared?.(evidence)
  }
  return () => {
    if (previous.onProviderRequest) config._onProviderRequest = previous.onProviderRequest
    else delete config._onProviderRequest
    if (previous.onProviderUsage) config._onProviderUsage = previous.onProviderUsage
    else delete config._onProviderUsage
    if (previous.onProviderActivity) config._onProviderActivity = previous.onProviderActivity
    else delete config._onProviderActivity
    if (previous.onProviderQuiet) config._onProviderQuiet = previous.onProviderQuiet
    else delete config._onProviderQuiet
    if (previous.onInferencePrepared) config._onInferencePrepared = previous.onInferencePrepared
    else delete config._onInferencePrepared
    if (previous.abortSignal) config._abortSignal = previous.abortSignal
    else delete config._abortSignal
  }
}

function compareTrackerIsUnknown(tracker, error = null) {
  const status = String(tracker?.status || '')
  const code = String(error?.code || error?.message || '')
  return ['status_unknown', 'provider_quiet'].includes(status)
    || /model_task_duplicate_(active|terminal)|status_unknown|provider_quiet|result_expired/.test(code)
}

async function loadCompareTaskByIdempotency(taskInput) {
  if (!taskInput?.taskKind || !taskInput?.idempotencyKey) return null
  return queryOne(`SELECT task_id, status FROM ai_model_tasks
    WHERE task_kind = ? AND idempotency_key = ? LIMIT 1`, [taskInput.taskKind, taskInput.idempotencyKey])
}

function parseLiveCompareResult(row) {
  if (!row?.result_json) return null
  try { return JSON.parse(row.result_json) } catch { return null }
}

/**
 * Live comparison keeps its synchronous response contract, but the durable
 * row is the billing/idempotency boundary. A client retry within the same
 * ten-minute input window returns the committed result or the active state;
 * it never starts a second set of provider calls.
 */
export async function handleAnalyzeCompare(userId, params = {}) {
  const nowMs = Date.now()
  const explicitIdempotency = Boolean(String(params.idempotency_key || params.request_id || '').trim())
  const sourceHash = liveCompareSourceHash(userId, params)
  if (!explicitIdempotency) {
    const active = await queryOne(`SELECT * FROM ai_model_compare_jobs WHERE user_id = ?
      AND JSON_UNQUOTE(JSON_EXTRACT(params_json, '$.job_type')) = 'live'
      AND JSON_UNQUOTE(JSON_EXTRACT(params_json, '$.live_source_hash')) = ?
      AND status IN ('queued','running','status_unknown') ORDER BY created_at DESC LIMIT 1`,
    [Number(userId), sourceHash])
    const activeDeadline = Number(safeCompareJson(active?.params_json, {})?.live_deadline_at_utc_msc || 0)
    if (active && (!activeDeadline || activeDeadline > nowMs)) {
      return parseLiveCompareResult(active) || { ok:false, status:String(active.status || 'running'),
        error:active.error_code || 'model_compare_already_running', job_id:String(active.id) }
    }
  }
  const idempotencyHash = liveCompareIdempotency(userId, params)
  const jobId = liveCompareJobId(idempotencyHash)
  const compareDeadline = modelTaskDeadlines('model_compare', { nowUtcMs:nowMs }).attemptSafetyDeadlineUtcMs
  const persistedParams = {
    ...params,
    job_type:'live',
    live_idempotency_hash:idempotencyHash,
    live_source_hash:sourceHash,
    live_deadline_at_utc_msc:compareDeadline,
  }
  try {
    await queryRun(`INSERT INTO ai_model_compare_jobs
      (id, user_id, status, stage, progress_percent, completed_steps, total_steps,
       params_json, result_json, error_code, cancel_requested, created_at, updated_at)
      VALUES (?, ?, 'running', 'inference', 5, 0, ?, ?, NULL, NULL, 0, NOW(), NOW())`,
    [jobId, Number(userId), Array.isArray(params.model_ids) ? params.model_ids.length : 0, JSON.stringify(persistedParams)])
  } catch (error) {
    const duplicate = error?.code === 'ER_DUP_ENTRY' || /duplicate/i.test(String(error?.message || ''))
    if (!duplicate) throw error
    const existing = await queryOne('SELECT * FROM ai_model_compare_jobs WHERE id = ? AND user_id = ? LIMIT 1',
      [jobId, Number(userId)])
    const committed = parseLiveCompareResult(existing)
    if (existing?.status === 'succeeded' && committed) return committed
    if (['running', 'queued'].includes(String(existing?.status || ''))) {
      return { ok:false, status:'running', error:'model_compare_already_running', job_id:jobId }
    }
    return committed || { ok:false, status:String(existing?.status || 'status_unknown'),
      error:existing?.error_code || 'model_compare_status_unknown', job_id:jobId }
  }

  try {
    const result = await executeAnalyzeCompare(userId, params, { jobId })
    const statusUnknown = result?.status === 'status_unknown'
      || result?.error === 'model_compare_status_unknown'
    const succeeded = result?.ok === true
    await queryRun(`UPDATE ai_model_compare_jobs SET status = ?, stage = ?, progress_percent = 100,
      completed_steps = total_steps, result_json = ?, error_code = ?, completed_at = NOW(), updated_at = NOW()
      WHERE id = ? AND user_id = ? AND status = 'running'`,
    [statusUnknown ? 'status_unknown' : succeeded ? 'succeeded' : 'failed',
      statusUnknown ? 'status_unknown' : succeeded ? 'succeeded' : 'failed', JSON.stringify(result),
      statusUnknown ? 'model_compare_status_unknown'
        : succeeded ? null : String(result?.error || result?.message || 'model_compare_failed').slice(0, 255),
      jobId, Number(userId)])
    return result
  } catch (error) {
    await queryRun(`UPDATE ai_model_compare_jobs SET status = 'failed', stage = 'failed', progress_percent = 100,
      error_code = ?, completed_at = NOW(), updated_at = NOW() WHERE id = ? AND user_id = ? AND status = 'running'`,
    [String(error?.code || error?.message || 'model_compare_failed').slice(0, 255), jobId, Number(userId)]).catch(() => {})
    throw error
  }
}

export async function handleHistoryCompare(userId, params, options = {}) {
  let { symbol } = params
  const { model_ids, strategy_id, start_time, end_time, step, sample_size } = params
  const dataSource = params.data_source === 'snapshots' ? 'snapshots' : 'historical'
  const evaluationMode = dataSource === 'snapshots'
    ? 'sampled'
    : params.evaluation_mode == null || params.evaluation_mode === 'sampled'
    ? 'sampled'
    : params.evaluation_mode === 'continuous' ? 'continuous' : null
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : async () => {}
  const shouldCancel = typeof options.shouldCancel === 'function' ? options.shouldCancel : () => false
  const abortSignal = options.abortSignal || null
  const compareJobId = String(options.jobId || `history-${comparisonFingerprint({ userId:Number(userId), params })}`)
  const expectedCheckpointManifest = options.checkpointManifest || null
  const checkpointRowsByUnit = options.checkpointsByUnit instanceof Map
    ? options.checkpointsByUnit
    : new Map((options.checkpoints || []).map(row => [String(row.unit_key), row]))
  const onCheckpointManifest = typeof options.onCheckpointManifest === 'function'
    ? options.onCheckpointManifest : async () => {}
  const onCheckpoint = typeof options.onCheckpoint === 'function' ? options.onCheckpoint : async () => {}

  const user = await queryOne('SELECT role FROM users WHERE id = ?', [userId])
  if (!user || user.role !== 'admin') return { status: 'error', message: 'admin_only' }
  const modelOwnerId = 0
  if (!strategy_id) return { status: 'error', message: 'strategy required' }
  if (dataSource === 'historical' && (!start_time || !end_time)) return { status: 'error', message: 'start_time and end_time required' }
  if (!evaluationMode) return { status:'error', message:'invalid_history_evaluation_mode' }
  if (!Array.isArray(model_ids) || model_ids.length < 2 || model_ids.length > 5) {
    return { status: 'error', message: 'model_ids must be an array of 2-5 model profile IDs' }
  }

  const uniqueIds = [...new Set(model_ids.map(Number))]
  if (uniqueIds.length < 2 || uniqueIds.length > 5) {
    return { status: 'error', message: 'model_ids must contain 2-5 unique IDs' }
  }

  const strategy = await getStrategyById(Number(strategy_id), userId, 'admin', { forExecution: false })
  if (!strategy) return { status: 'error', message: 'strategy_not_found' }

  let snapshotRun = null
  if (dataSource === 'snapshots') {
    try {
      snapshotRun = await resolveModelSnapshotSelection(userId, params.snapshot_ids, {
        strategy_id:strategy_id,
        symbol,
      })
      symbol = snapshotRun.symbol
    } catch (error) {
      return { status:'error', message:error.message || 'snapshot_compare_selection_invalid' }
    }
  }
  if (!symbol) return { status: 'error', message: 'symbol required' }

  const supportedSymbols = new Set(parsePromptSymbols(strategy.symbols_json).map(item => stripBrokerSuffix(String(item)).toUpperCase()))
  if (!supportedSymbols.has(stripBrokerSuffix(symbol).toUpperCase())) return { status: 'error', message: 'symbol_not_supported_by_strategy' }
  const policy = parseStrategyPolicy(strategy)
  const currentAiVolumeRange = await resolvePlatformAiVolumeRange()
  const planItems = policy.marketDataPlan.timeframes.map(item => ({
    timeframe: String(item.timeframe || '').toUpperCase(),
    kline_count: Math.max(20, Number(item.kline_count) || 100),
  })).filter(item => TIMEFRAME_MINUTES[item.timeframe])
  let requestedTimeframe = String(policy.marketDataPlan.primary_timeframe || planItems[0]?.timeframe || '').toUpperCase()
  if (!requestedTimeframe || !planItems.some(item => item.timeframe === requestedTimeframe)) {
    return { status: 'error', message: 'strategy_primary_timeframe_invalid' }
  }
  const configuredEvaluationTimeframe = String(params.evaluation_timeframe
    || resolveStrategyEvaluationTimeframe(strategy, planItems) || '').toUpperCase()
  if (snapshotRun) requestedTimeframe = snapshotPrimaryTimeframe(snapshotRun, requestedTimeframe)
  const evaluationTimeframe = snapshotRun
    ? resolveLockedSnapshotEvaluationTimeframe(snapshotRun)
    : configuredEvaluationTimeframe
  if (!evaluationTimeframe) return { status:'error', message:'strategy_evaluation_timeframe_invalid' }
  const backtestOptions = normalizeBacktestOptions(params.backtest || {})
  const evaluatorStrategySnapshot = {
    strategy_id:Number(strategy.id),
    strategy_version:Number(strategy.version || 1),
    scope:strategy.scope || null,
    system_prompt_sha256:comparisonFingerprint(strategy.system_prompt || ''),
    market_data_plan:policy.marketDataPlan,
    entry_methods:policy.entryMethods,
    use_chan_analysis:Boolean(policy.useChanAnalysis),
    strategy_policy_mode:policy.policyMode,
    strategy_policy_hash:policy.compiledPolicy?.policy_hash || null,
    interval_minutes:Number(strategy.interval_minutes || 0),
  }
  evaluatorStrategySnapshot.runtime_config_sha256 = comparisonFingerprint(evaluatorStrategySnapshot)
  const snapshotPromptPlan = snapshotRun ? snapshotPromptTimeframePlan(snapshotRun.samples[0]) : []
  const snapshotChanEnabled = resolveSnapshotChanEnabled(snapshotRun?.samples)
  const snapshotPlan = snapshotRun ? {
    primary_timeframe:requestedTimeframe,
    timeframes:snapshotPromptPlan.length ? snapshotPromptPlan
      : snapshotTimeframes(snapshotRun.samples).map(timeframe => ({ timeframe })),
  } : null
  const strategyRuntimeSnapshot = snapshotRun ? {
    strategy_id:Number(snapshotRun.strategy_id),
    strategy_version:Number(snapshotRun.strategy_version || 1),
    scope:snapshotRun.samples[0]?.strategy_scope || strategy.scope || null,
    system_prompt_sha256:comparisonFingerprint(snapshotRun.samples[0]?.system_prompt || ''),
    market_data_plan:snapshotPlan,
    entry_methods:snapshotAllowedEntryMethods(snapshotRun.samples[0], ['market', 'limit', 'stop', 'stop_limit']),
    use_chan_analysis:snapshotChanEnabled,
    interval_minutes:Number(TIMEFRAME_MINUTES[evaluationTimeframe] || 0),
    evidence_source:'inference_snapshot',
    strategy_policy_mode:snapshotRun.samples[0]?.strategy_runtime?.mode || 'legacy_implicit',
    strategy_policy_hash:snapshotRun.samples[0]?.strategy_runtime?.policy_hash || null,
  } : evaluatorStrategySnapshot
  strategyRuntimeSnapshot.runtime_config_sha256 = comparisonFingerprint(strategyRuntimeSnapshot)
  const runtimePolicy = snapshotRun ? {
    entryMethods:strategyRuntimeSnapshot.entry_methods,
    marketDataPlan:strategyRuntimeSnapshot.market_data_plan,
    useChanAnalysis:strategyRuntimeSnapshot.use_chan_analysis,
    marketOnly:strategyRuntimeSnapshot.scope === 'platform',
    compiledPolicy:snapshotRun.samples[0]?.strategy_runtime?.compiled_policy || null,
    policyMode:snapshotRun.samples[0]?.strategy_runtime?.mode || 'off',
  } : {
    entryMethods:policy.entryMethods,
    marketDataPlan:policy.marketDataPlan,
    useChanAnalysis:policy.useChanAnalysis,
    marketOnly:strategy.scope === 'platform',
    compiledPolicy:policy.compiledPolicy,
    policyMode:policy.policyMode,
  }

  const selectionTimezoneOffsetMinutes = await resolveCompareTimezoneOffset(params)
  let normalizedTimeRange
  try {
    if (dataSource === 'snapshots') {
      const decisions = snapshotRun.samples.map(sample => snapshotDecisionPoint(
        sample, evaluationTimeframe, selectionTimezoneOffsetMinutes,
      ).decisionUtcMs)
      const maximumHoldingMs = normalizeBacktestOptions(params.backtest || {}).max_holding_hours * 3_600_000
      normalizedTimeRange = {
        startUtcMs:Math.min(...decisions),
        endUtcMs:Math.min(Date.now(), Math.max(...decisions) + maximumHoldingMs + 60_000),
      }
      normalizedTimeRange.startTime = new Date(normalizedTimeRange.startUtcMs).toISOString()
      normalizedTimeRange.endTime = new Date(normalizedTimeRange.endUtcMs).toISOString()
    } else {
      normalizedTimeRange = normalizeHistoryCompareTimeRange(start_time, end_time, selectionTimezoneOffsetMinutes)
    }
  } catch (error) {
    return { status:'error', message:error.message || 'invalid_history_time_range' }
  }
  const { startUtcMs, endUtcMs } = normalizedTimeRange
  let historyWindows = []
  try {
    historyWindows = dataSource === 'historical' ? await Promise.all(planItems.map(async item => {
      const chanPolicy = policy.useChanAnalysis ? getChanWindowPolicy(item.timeframe) : null
      const warmupCount = Math.max(item.kline_count, chanPolicy?.target || 0)
      const itemWarmupMs = TIMEFRAME_MINUTES[item.timeframe] * warmupCount * 2 * 60_000
      return {
        ...item,
        window:await loadPeriodMarketWindow(
          userId, symbol, item.timeframe, startUtcMs - itemWarmupMs, endUtcMs,
          { alignToPeriodStart:false },
        ),
      }
    })) : []
  } catch (error) {
    return { status: 'error', message: error.message || 'history_market_data_unavailable' }
  }
  const marketDataEvidence = snapshotRun
    ? snapshotRun.samples.map(sample => ({
      snapshot_id:sample.snapshot_id,
      signal_id:sample.signal_id,
      content_hash:sample.content_hash,
      prompt_hash:sample.prompt_hash,
      strategy_version:sample.strategy_version,
      output_schema_version:sample.output_schema_version || null,
      market_source:'inference_snapshot',
    }))
    : historyWindows.map(item => ({
      ...comparisonRatesEvidence(item.timeframe, item.window?.periodRates),
      market_source:item.window?.marketMeta?.source || item.window?.marketMeta?.source_type || null,
      timezone_offset_minutes:Number.isFinite(Number(item.window?.marketMeta?.timezone_offset_minutes))
        ? Number(item.window.marketMeta.timezone_offset_minutes) : null,
    }))
  const selectedWindow = historyWindows.find(item => item.timeframe === requestedTimeframe)
  const evaluationWindow = historyWindows.find(item => item.timeframe === evaluationTimeframe)
  const evaluationDurationMs = (TIMEFRAME_MINUTES[evaluationTimeframe] || 1) * 60_000
  const evaluationCutoffUtcMs = Math.min(endUtcMs, Date.now())
  const requestedRates = Array.isArray(evaluationWindow?.window?.periodRates)
    ? evaluationWindow.window.periodRates.filter(rate => {
      const utcMs = compareRateUtcMs(rate)
      return utcMs != null && utcMs >= startUtcMs
        && utcMs + evaluationDurationMs <= evaluationCutoffUtcMs
    })
    : []
  if (requestedRates.length > HISTORY_COMPARE_MAX_KLINES) {
    return { status: 'error', message: 'history_compare_range_too_large' }
  }
  const klines = requestedRates
  if (dataSource === 'historical' && evaluationMode === 'sampled' && klines.length <= HISTORY_COMPARE_MIN_CONTEXT) {
    return { status: 'error', message: 'insufficient_kline_data_for_compare' }
  }
  if (evaluationMode === 'continuous' && klines.length < 2) {
    return { status:'error', message:'insufficient_kline_data_for_compare' }
  }

  // `step` remains accepted for older clients. New clients request an explicit,
  // evenly distributed sample size so the evaluation covers the whole range.
  const requestedSampleSize = sample_size == null
    ? Math.max(HISTORY_COMPARE_MIN_STEPS, Math.min(HISTORY_COMPARE_MAX_STEPS,
      Math.ceil((klines.length - HISTORY_COMPARE_MIN_CONTEXT) / Math.max(1, Number(step) || 10))))
    : Math.max(HISTORY_COMPARE_MIN_STEPS, Math.min(HISTORY_COMPARE_MAX_STEPS, Number(sample_size) || 12))
  const steps = dataSource === 'snapshots'
    ? []
    : evaluationMode === 'continuous'
      ? buildContinuousHistoryCompareSteps(klines.length)
      : buildHistoryCompareSteps(klines.length, requestedSampleSize)
  const decisionPoints = dataSource === 'snapshots'
    ? (await Promise.all(snapshotRun.samples.map(async sample => {
      const point = snapshotDecisionPoint(sample, evaluationTimeframe, selectionTimezoneOffsetMinutes)
      const outcomeKline = await loadSnapshotOutcomeKline(
        userId, symbol, point.timeframe, point.outcomeOpenUtcMs,
      )
      return outcomeKline ? {
        decisionUtcMs:point.decisionUtcMs,
        outcomeOpenUtcMs:point.outcomeOpenUtcMs,
        outcomeKline,
        snapshotSample:sample,
      } : null
    }))).filter(Boolean)
    : steps.map(stepIdx => ({
      stepIdx,
      decisionUtcMs:compareRateUtcMs(klines[stepIdx]) + evaluationDurationMs,
      outcomeKline:klines[stepIdx + 1],
      snapshotSample:null,
    })).filter(item => item.outcomeKline)
  if (dataSource === 'snapshots' && decisionPoints.length !== snapshotRun.samples.length) {
    return { status:'error', message:'snapshot_compare_outcome_candles_incomplete' }
  }
  if (evaluationMode === 'continuous' && decisionPoints.length > HISTORY_COMPARE_MAX_CONTINUOUS_STEPS) {
    return {
      status:'error',
      message:'continuous_backtest_range_too_large',
      evaluation_count:decisionPoints.length,
      max_evaluation_count:HISTORY_COMPARE_MAX_CONTINUOUS_STEPS,
    }
  }

  // Validate every decision point before resolving or calling any model. A
  // continuous backtest is only meaningful when all strategy timeframes have
  // the minimum closed-candle context at every evaluated primary-bar close.
  for (const decisionPoint of dataSource === 'historical' ? decisionPoints : []) {
    const decisionUtcMs = decisionPoint.decisionUtcMs
    const missingTimeframes = historyWindows.filter(item => {
      const sourceRates = Array.isArray(item.window?.periodRates) ? item.window.periodRates : []
      return compareVisibleRates(sourceRates, decisionUtcMs, item.timeframe, item.kline_count, policy.useChanAnalysis)
        .length < Math.min(20, item.kline_count)
    }).map(item => item.timeframe)
    if (missingTimeframes.length) {
      return {
        status:'error',
        message:'history_compare_strategy_context_incomplete',
        missing_timeframes:missingTimeframes,
        decision_time_utc_msc:decisionUtcMs,
      }
    }
  }

  const prompt = strategy.system_prompt || ''
  await onProgress({ stage: 'market_ready', progress_percent: 10, completed_steps: 0, total_steps: 0 })

  const profileResults = await Promise.allSettled(
    uniqueIds.map(async (modelId) => {
      const resolved = await resolveOwnedModelProfileForRuntime(modelId, modelOwnerId)
      if (!resolved.model || !resolved.model.api_key_encrypted) {
        throw new Error(resolved.error || 'model_profile_not_found_or_inactive')
      }
      return { modelId, resolved }
    })
  )

  const validModels = []
  const modelErrors = []
  for (let i = 0; i < uniqueIds.length; i++) {
    const profileResult = profileResults[i]
    if (profileResult.status === 'rejected' || !profileResult.value) {
      modelErrors.push({
        model_id:uniqueIds[i],
        status:'error',
        error:boundedComparisonError(profileResult.reason?.message, 'model_profile_resolution_failed'),
      })
    } else {
      validModels.push(profileResult.value)
    }
  }
  if (validModels.length < 2) {
    return { status: 'error', message: 'insufficient_available_models', model_errors: modelErrors }
  }

  const modelSignals = {}
  for (const { modelId } of validModels) {
    modelSignals[modelId] = []
  }
  const modelRuntimeSnapshots = Object.fromEntries(validModels.map(({ modelId, resolved }) =>
    [modelId, comparisonModelSnapshot(modelId, resolved)]))
  // Historical replay freezes the complete unified strategy memory exactly
  // once per compare job. A resumed job uses the manifest copy rather than a
  // newer live library. Snapshot replay deliberately skips this branch: its
  // persisted prompt is the sole historical input.
  let historyMemorySnapshot = null
  if (dataSource === 'historical') {
    const manifest = expectedCheckpointManifest
    const hasFrozenMemory = manifest
      && manifest.memory_library_version_no !== null
      && manifest.memory_library_version_no !== undefined
      && manifest.memory_library_content_hash
      && manifest.memory_library_content_text !== null
      && manifest.memory_library_content_text !== undefined
    if (manifest && !hasFrozenMemory) {
      // A resumed historical job must never fall back to today's library. Old
      // manifests without the frozen memory snapshot are not replay-safe.
      return { status:'error', message:'history_compare_checkpoint_source_stale' }
    }
    if (hasFrozenMemory) {
      const frozenText = String(manifest.memory_library_content_text)
      try {
        historyMemorySnapshot = compareMemoryIdentity({
          version_no:manifest.memory_library_version_no,
          content_hash:manifest.memory_library_content_hash,
          content_text:frozenText,
        })
      } catch {
        return { status:'error', message:'history_compare_memory_snapshot_invalid' }
      }
    } else {
      try {
        const resolvedMemory = await getStrategyMemoryLibraryForRuntime({ strategyId:Number(strategy.id),
          userId, role:'admin' })
        historyMemorySnapshot = compareMemoryIdentity(resolvedMemory?.library, {
          missingCode:'strategy_memory_library_unavailable',
          invalidCode:'history_compare_memory_snapshot_invalid',
        })
      } catch (error) {
        console.error('[HistoryCompare] Strategy memory library unavailable:', error.message)
        return { status:'error', message:error?.code === 'history_compare_memory_snapshot_invalid'
          ? 'history_compare_memory_snapshot_invalid' : 'strategy_memory_library_unavailable' }
      }
    }
  }
  const checkpointManifest = buildHistoryCompareCheckpointManifest({
    strategy, strategyRuntimeSnapshot, snapshotRun, dataSource, validModels,
    modelRuntimeSnapshots, decisionPoints, marketDataEvidence, prompt,
    memorySnapshot:historyMemorySnapshot,
  })
  if (expectedCheckpointManifest
    && !historyCompareCheckpointManifestMatches(expectedCheckpointManifest, checkpointManifest)) {
    return { status:'error', message:'history_compare_checkpoint_source_stale' }
  }
  const checkpointRows = [...checkpointRowsByUnit.values()]
  if (checkpointRows.some(row => !['completed', 'failed'].includes(String(row.checkpoint_status || 'completed')))) {
    return { status:'status_unknown', message:'history_compare_status_unknown' }
  }
  const completedCheckpointRows = checkpointRows.filter(row => String(row.checkpoint_status || 'completed') === 'completed')
  if (completedCheckpointRows.some(row => !historyCompareCheckpointMatchesManifest(row, checkpointManifest)
    || !row.result || typeof row.result !== 'object')) {
    return { status:'error', message:'history_compare_checkpoint_source_stale' }
  }
  const failedCheckpointRows = checkpointRows.filter(row => String(row.checkpoint_status || '') === 'failed')
  if (failedCheckpointRows.some(row => !historyCompareCheckpointMatchesManifest(row, checkpointManifest))) {
    return { status:'error', message:'history_compare_checkpoint_source_stale' }
  }
  if (failedCheckpointRows.some(row => !row.result || typeof row.result !== 'object')) {
    return { status:'status_unknown', message:'history_compare_status_unknown' }
  }
  const completedCheckpointRowsByUnit = new Map(completedCheckpointRows
    .map(row => [String(row.unit_key), row]))
  const failedCheckpointRowsByUnit = new Map(checkpointRows
    .filter(row => String(row.checkpoint_status || '') === 'failed')
    .map(row => [String(row.unit_key), row]))
  await onCheckpointManifest(checkpointManifest)
  const modelTelemetry = Object.fromEntries(validModels.map(({ modelId }) => [modelId, {
    provider_request_count:0,
    repair_request_count:0,
    successful_request_count:0,
    failed_request_count:0,
    token_count:0,
  }]))
  const decisionInputEvidence = new Map()

  await onProgress({ stage: 'models_ready', progress_percent: 15, completed_steps: 0, total_steps: decisionPoints.length })

  for (let stepNumber = 0; stepNumber < decisionPoints.length; stepNumber++) {
    if (shouldCancel()) return { status: 'cancelled', message: 'history_compare_cancelled' }
    const decisionPoint = decisionPoints[stepNumber]
    const decisionUtcMs = decisionPoint.decisionUtcMs
    let market
    if (decisionPoint.snapshotSample) {
      market = hydrateSnapshotMarket(decisionPoint.snapshotSample)
    } else {
    const strategyTimeframes = {}
    const policyIndicatorSources = {}
    const missingTimeframes = []
    for (const item of historyWindows) {
      const sourceRates = Array.isArray(item.window?.periodRates) ? item.window.periodRates : []
      const contextRates = compareVisibleRates(sourceRates, decisionUtcMs, item.timeframe, item.kline_count, policy.useChanAnalysis)
      if (contextRates.length < Math.min(20, item.kline_count)) {
        missingTimeframes.push(item.timeframe)
        continue
      }
      const visibleContextRates = contextRates.slice(-item.kline_count)
      const historicalDataQuality = {
        ...(item.window?.marketMeta || {}),
        last_bar_closed:true,
        chan_structure_anchor_utc_msc:null,
        chan_last_confirmed_segment_utc_msc:null,
      }
      const summary = calculateMarketData(symbol, item.timeframe, visibleContextRates, null, [], {
        computeChan: policy.useChanAnalysis,
        chanRates: contextRates,
        requestedChanHistoryCount:policy.useChanAnalysis ? getChanWindowPolicy(item.timeframe).target : contextRates.length,
        chanMaximumHistoryCount:policy.useChanAnalysis ? getChanWindowPolicy(item.timeframe).target : null,
        chanValidationWindowCounts:policy.useChanAnalysis ? getChanWindowPolicy(item.timeframe).validators : null,
        chanWindowPolicyVersion:policy.useChanAnalysis ? CHAN_WINDOW_POLICY_VERSION : null,
        chanDataQuality: historicalDataQuality,
      })
      const { account: _account, positions: _positions, symbol: _symbol, timeframe: _timeframe, timestamp: _timestamp, ...slimSummary } = summary
      strategyTimeframes[item.timeframe] = { summary: slimSummary, klines: compactRates(visibleContextRates) }
      policyIndicatorSources[item.timeframe] = {
        bars:compactRates(contextRates), lastBarClosed:true,
        internalGapUnresolved:historicalDataQuality.internal_gap_unresolved === true,
        marketSource:historicalDataQuality.source || 'historical_compare',
      }
    }
    const primaryRates = compareVisibleRates(
      selectedWindow.window.periodRates, decisionUtcMs, requestedTimeframe,
      selectedWindow.kline_count, policy.useChanAnalysis
    )
    const primaryHistoricalDataQuality = {
      ...(selectedWindow.window?.marketMeta || {}),
      last_bar_closed:true,
      chan_structure_anchor_utc_msc:null,
      chan_last_confirmed_segment_utc_msc:null,
    }
    market = calculateMarketData(symbol, requestedTimeframe, primaryRates.slice(-selectedWindow.kline_count), null, [], {
      computeChan: policy.useChanAnalysis,
      chanRates: primaryRates,
      requestedChanHistoryCount:policy.useChanAnalysis ? getChanWindowPolicy(requestedTimeframe).target : primaryRates.length,
      chanMaximumHistoryCount:policy.useChanAnalysis ? getChanWindowPolicy(requestedTimeframe).target : null,
      chanValidationWindowCounts:policy.useChanAnalysis ? getChanWindowPolicy(requestedTimeframe).validators : null,
      chanWindowPolicyVersion:policy.useChanAnalysis ? CHAN_WINDOW_POLICY_VERSION : null,
      chanDataQuality: primaryHistoricalDataQuality,
    })
    market.strategy_context = {
      strategy_sequence: planItems.map(item => `${item.timeframe}(${item.kline_count})`).join(' → '),
      required_timeframes: planItems.map(item => item.timeframe),
      used_timeframes: Object.keys(strategyTimeframes),
      missing_timeframes: missingTimeframes,
      context_status: missingTimeframes.length ? 'partial' : 'complete',
      timeframes: strategyTimeframes,
    }
    Object.defineProperty(market.strategy_context, 'policyIndicatorSources', { value:policyIndicatorSources, enumerable:false })
    market.requested_timeframes = market.strategy_context.required_timeframes
    market.used_timeframes = market.strategy_context.used_timeframes
    market.missing_timeframes = missingTimeframes
    if (policy.useChanAnalysis) market.chan = strategyTimeframes[requestedTimeframe]?.summary?.chan
    }

    const baseStrategyDataRuntime = decisionPoint.snapshotSample
      ? (decisionPoint.snapshotSample.strategy_runtime ? structuredClone(decisionPoint.snapshotSample.strategy_runtime) : null)
      : prepareStrategyDataRuntime(runtimePolicy, market.strategy_context, { rawPolicy:policy.strategyPolicy })
    if (!decisionPoint.snapshotSample && baseStrategyDataRuntime?.indicators) {
      market.strategy_context.indicators = structuredClone(baseStrategyDataRuntime.indicators)
    }

    const persistCheckpointState = async (modelId, state = {}) => {
      const modelSnapshot = modelRuntimeSnapshots[modelId]
      await onCheckpoint({
        model_id:Number(modelId),
        unit_key:historyCompareCheckpointUnitKey(modelId, stepNumber),
        unit_index:stepNumber,
        checkpoint_status:state.checkpoint_status || 'completed',
        error_code:state.error_code || null,
        decision_time_utc_msc:decisionUtcMs,
        outcome_time_utc_msc:compareRateUtcMs(decisionPoint.outcomeKline),
        snapshot_id:decisionPoint.snapshotSample?.snapshot_id == null ? null : Number(decisionPoint.snapshotSample.snapshot_id),
        strategy_fingerprint:checkpointManifest.strategy_fingerprint,
        prompt_hash:checkpointManifest.prompt_hash,
        snapshot_fingerprint:checkpointManifest.snapshot_fingerprint,
        model_config_fingerprint:modelSnapshot?.runtime_config_sha256 || '',
        output_contract_hash:checkpointManifest.output_contract_hash,
        market_evidence_hash:checkpointManifest.market_evidence_hash,
        result:state.result || null,
        telemetry:state.telemetry || {},
        input_evidence:state.input_evidence || null,
      })
    }

    const historyBatchAbortController = new AbortController()
    const historyStepAbortSignal = mergeCompareAbortSignals(abortSignal, historyBatchAbortController.signal)
    const historyStepTrackers = new Set()
    const inferenceTaskPromises = validModels.map(async ({ modelId, resolved }) => {
      const checkpointUnitKey = historyCompareCheckpointUnitKey(modelId, stepNumber)
      const checkpoint = completedCheckpointRowsByUnit.get(checkpointUnitKey)
      if (checkpoint) {
        const restoredTelemetry = checkpoint.telemetry || {}
        for (const key of Object.keys(modelTelemetry[modelId])) {
          modelTelemetry[modelId][key] += Math.max(0, Number(restoredTelemetry[key]) || 0)
        }
        if (checkpoint.input_evidence) {
          const evidenceKey = `${decisionUtcMs}:${decisionPoint.snapshotSample?.snapshot_id || stepNumber}`
          decisionInputEvidence.set(evidenceKey, checkpoint.input_evidence)
        }
        return {
          modelId,
          checkpoint:true,
          restoredSignal:checkpoint.result,
          latencyMs:Number(checkpoint.result?.latency_ms || 0),
        }
      }
      const failedCheckpoint = failedCheckpointRowsByUnit.get(checkpointUnitKey)
      if (failedCheckpoint) {
        const restoredTelemetry = failedCheckpoint.telemetry || {}
        for (const key of Object.keys(modelTelemetry[modelId])) {
          modelTelemetry[modelId][key] += Math.max(0, Number(restoredTelemetry[key]) || 0)
        }
        if (failedCheckpoint.input_evidence) {
          const evidenceKey = `${decisionUtcMs}:${decisionPoint.snapshotSample?.snapshot_id || stepNumber}`
          decisionInputEvidence.set(evidenceKey, failedCheckpoint.input_evidence)
        }
        return {
          modelId,
          checkpoint:true,
          restoredSignal:failedCheckpoint.result,
          latencyMs:Number(failedCheckpoint.result?.latency_ms || 0),
        }
      }
      const telemetryBefore = { ...modelTelemetry[modelId] }
      let preparedEvidence = null
      const snapshotVolumeRange = decisionPoint.snapshotSample?.market_snapshot?.ai_volume_range || currentAiVolumeRange
      const config = {
        ...resolved.model,
        system_prompt: prompt,
        _userId: userId,
        _usage: 'model_compare',
        _strategyId:Number(strategy.id),
        _model_shared: resolved.credential_source === 'platform_shared',
        _model_profile_id: resolved.model_profile_id,
        _credential_source: resolved.credential_source,
        _allowed_entry_methods:decisionPoint.snapshotSample
          ? snapshotAllowedEntryMethods(decisionPoint.snapshotSample, runtimePolicy.entryMethods)
          : runtimePolicy.entryMethods,
        _market_data_plan:runtimePolicy.marketDataPlan,
        _use_chan_analysis:runtimePolicy.useChanAnalysis,
        _market_only:runtimePolicy.marketOnly,
        _ai_volume_min:Number(snapshotVolumeRange.min ?? currentAiVolumeRange.min),
        _ai_volume_max:Number(snapshotVolumeRange.max ?? currentAiVolumeRange.max),
        _ai_volume_step:Number(snapshotVolumeRange.step ?? currentAiVolumeRange.step),
        _comparison_mode:true,
        _comparison_replay_system_prompt:decisionPoint.snapshotSample
          ? String(decisionPoint.snapshotSample.system_prompt || '') : undefined,
        // An explicit string (including an empty one) tells llm.js that this
        // is a snapshot replay and prevents any live strategy-memory payload
        // from being appended to the historical user prompt.
        _comparison_replay_user_prompt:decisionPoint.snapshotSample
          ? String(decisionPoint.snapshotSample.user_prompt || '') : undefined,
        _comparison_replay_output_schema_version:decisionPoint.snapshotSample?.output_schema_version,
        ...(!decisionPoint.snapshotSample && historyMemorySnapshot ? {
          _strategyMemoryLibraryContext:historyMemorySnapshot.content_text,
          _strategyMemoryLibraryVersion:Number(historyMemorySnapshot.version_no),
          _strategyMemoryLibraryHash:historyMemorySnapshot.content_hash,
          _memoryMode:'strategy_library',
          _experienceSelection:{ source:'strategy_library', selectedItemIds:[], selectedRefs:[], selectionDetails:[] },
        } : {}),
      }
      const strategyDataRuntime = baseStrategyDataRuntime ? structuredClone(baseStrategyDataRuntime) : null
      const unitInputHash = comparisonFingerprint({
        job_id:compareJobId, mode:'history', unit_key:checkpointUnitKey,
        decision_time_utc_msc:decisionUtcMs, snapshot_id:decisionPoint.snapshotSample?.snapshot_id || null,
        strategy_fingerprint:checkpointManifest.strategy_fingerprint,
        prompt_hash:checkpointManifest.prompt_hash,
        snapshot_fingerprint:checkpointManifest.snapshot_fingerprint,
        model_config_fingerprint:modelRuntimeSnapshots[modelId]?.runtime_config_sha256 || '',
        output_contract_hash:checkpointManifest.output_contract_hash,
        market_evidence_hash:checkpointManifest.market_evidence_hash,
        memory_library_version_no:historyMemorySnapshot?.version_no ?? null,
        memory_library_content_hash:historyMemorySnapshot?.content_hash || null,
        strategy_data_runtime_version:strategyDataRuntime?.data_runtime_version || null,
        strategy_policy_hash:strategyDataRuntime?.policy_hash || null,
        indicator_evidence_hashes:strategyDataRuntime?.indicator_evidence_hashes
          || strategyDataRuntime?.audit_identity?.indicator_evidence_hashes || {},
      })
      const taskEnvelope = compareUnitTaskInput({
        userId, strategy, config, jobId:compareJobId, mode:'history', unitKey:checkpointUnitKey,
        modelId, inputHash:unitInputHash,
        promptHash:checkpointManifest.prompt_hash,
        snapshotHash:checkpointManifest.snapshot_fingerprint,
        outputContractHash:checkpointManifest.output_contract_hash,
        marketEvidenceHash:checkpointManifest.market_evidence_hash,
        decisionUtcMs, strategyMemory:historyMemorySnapshot, strategyDataRuntime,
      })
      let tracker = null
      let restoreCallbacks = null
      await persistCheckpointState(modelId, { checkpoint_status:'submitting', telemetry:{} })
      if (historyStepAbortSignal?.aborted) {
        throw historyStepAbortSignal.reason || new Error('history_compare_batch_aborted')
      }
      try {
        try {
          tracker = await createModelTaskTracker(taskEnvelope.input, {
            workerId:`model-compare:${compareJobId}:${checkpointUnitKey}`,
          })
        } catch (error) {
          const duplicate = /model_task_duplicate_(active|terminal)/.test(String(error?.code || error?.message || ''))
          if (duplicate) {
            const existingTask = await loadCompareTaskByIdempotency(taskEnvelope.input)
            await persistCheckpointState(modelId, {
              checkpoint_status:'submitting', telemetry:{ model_task_id:existingTask?.task_id || null },
            })
            return { modelId, status:'status_unknown', error:'history_compare_status_unknown',
              model_task_id:existingTask?.task_id || null }
          }
          throw error
        }
        historyStepTrackers.add(tracker)
        if (!decisionPoint.snapshotSample && historyMemorySnapshot) {
          await ensureCompareStrategyMemoryInjectionLog({
            strategyId:Number(strategy.id), actor:{ userId, role:'admin' },
            library:historyMemorySnapshot, modelTaskId:tracker.taskId,
            usageKind:'model_compare_history',
          })
        }
        if (historyStepAbortSignal?.aborted) {
          throw historyStepAbortSignal.reason || new Error('history_compare_batch_aborted')
        }
        restoreCallbacks = installCompareTrackerCallbacks(config, tracker, {
          abortSignal:historyStepAbortSignal,
          taskDeadlineAtUtcMs:taskEnvelope.deadlines.attemptSafetyDeadlineUtcMs,
          resultValidUntilUtcMs:taskEnvelope.deadlines.attemptSafetyDeadlineUtcMs,
          onProviderRequest:({ phase }) => {
            modelTelemetry[modelId].provider_request_count += 1
            if (phase === 'repair') modelTelemetry[modelId].repair_request_count += 1
          },
          onProviderUsage:({ status, tokenCount }) => {
            if (status === 'success') modelTelemetry[modelId].successful_request_count += 1
            else modelTelemetry[modelId].failed_request_count += 1
            modelTelemetry[modelId].token_count += Math.max(0, Number(tokenCount) || 0)
          },
          onInferencePrepared:({ systemPrompt, userPrompt, outputSchemaVersion }) => {
            preparedEvidence = {
              decision_time_utc_msc:decisionUtcMs,
              snapshot_id:decisionPoint.snapshotSample?.snapshot_id || null,
              system_prompt_sha256:comparisonFingerprint(systemPrompt || ''),
              user_prompt_sha256:comparisonFingerprint(userPrompt || ''),
              output_schema_version:outputSchemaVersion || null,
            }
            const evidenceKey = `${decisionUtcMs}:${decisionPoint.snapshotSample?.snapshot_id || stepNumber}`
            if (decisionInputEvidence.has(evidenceKey)) return
            decisionInputEvidence.set(evidenceKey, preparedEvidence)
          },
        })
        await persistCheckpointState(modelId, {
          checkpoint_status:'submitting', telemetry:{ model_task_id:tracker.taskId },
        })
        const startedAt = Date.now()
        try {
          let signal = await maybeAiSignal(null, config, market, prompt)
          const rawSignalType = signal.signal_type
          signal.decision_diagnostics = buildDecisionDiagnostics({
            signal, market, modelSignalType:rawSignalType,
          })
          const telemetry = Object.fromEntries(Object.keys(modelTelemetry[modelId]).map(key => [
            key, Math.max(0, Number(modelTelemetry[modelId][key]) - Number(telemetryBefore[key] || 0)),
          ]))
          await tracker.resultReady({
            resultRef:`model_compare:${compareJobId}:${checkpointUnitKey}`,
            resultHash:comparisonFingerprint(signal),
          })
          await tracker.applying()
          restoreCallbacks?.()
          return {
            modelId,
            latencyMs: Date.now() - startedAt,
            signal: { ...signal, _inference_source: signal._inference_source || 'unknown' },
            rawSignalType,
            strategyDataRuntime,
            preparedEvidence,
            telemetry,
            tracker,
          }
        } catch (error) {
          if (historyStepAbortSignal?.aborted) throw error
          const telemetry = Object.fromEntries(Object.keys(modelTelemetry[modelId]).map(key => [
            key, Math.max(0, Number(modelTelemetry[modelId][key]) - Number(telemetryBefore[key] || 0)),
          ]))
          try {
            await tracker.failed(error, true)
          } catch (transitionError) {
            if (compareTrackerIsUnknown(tracker, transitionError)) {
              restoreCallbacks?.()
              await tracker.stop().catch(() => {})
              return { modelId, status:'status_unknown', error:'history_compare_status_unknown', model_task_id:tracker.taskId }
            }
            error = transitionError
          }
          if (compareTrackerIsUnknown(tracker, error)) {
            restoreCallbacks?.()
            await tracker.stop().catch(() => {})
            return { modelId, status:'status_unknown', error:'history_compare_status_unknown', model_task_id:tracker.taskId }
          }
          restoreCallbacks?.()
          return {
            modelId,
            latencyMs:Date.now() - startedAt,
            error:boundedComparisonError(error.message, 'inference_failed'),
            preparedEvidence,
            telemetry,
            tracker,
          }
        }
      } catch (error) {
        restoreCallbacks?.()
        if (historyStepAbortSignal?.aborted) {
          if (tracker) await tracker.failed(error, true).catch(() => {})
          await tracker?.stop?.().catch(() => {})
          throw error
        }
        if (tracker && compareTrackerIsUnknown(tracker, error)) {
          await tracker.stop().catch(() => {})
          return { modelId, status:'status_unknown', error:'history_compare_status_unknown', model_task_id:tracker.taskId }
        }
        if (tracker) {
          await tracker.failed(error, true).catch(() => {})
          if (compareTrackerIsUnknown(tracker, error)) {
            await tracker.stop().catch(() => {})
            return { modelId, status:'status_unknown', error:'history_compare_status_unknown', model_task_id:tracker.taskId }
          }
          await tracker.stop().catch(() => {})
        }
        if (!tracker) throw error
        return { modelId, error:boundedComparisonError(error.message, 'inference_failed') }
      }
    })

    const inferenceTasks = inferenceTaskPromises.map(task => task.catch(error => {
      if (!historyBatchAbortController.signal.aborted) historyBatchAbortController.abort(error)
      throw error
    }))
    const settledInference = await Promise.allSettled(inferenceTasks)
    const rejectedInference = settledInference.find(item => item.status === 'rejected')
    if (rejectedInference) {
      if (!historyBatchAbortController.signal.aborted) historyBatchAbortController.abort(rejectedInference.reason)
      await Promise.allSettled([...historyStepTrackers].map(async tracker => {
        if (['result_ready', 'applying'].includes(String(tracker.status || ''))) {
          await tracker.completedStale('model_compare_peer_rejected').catch(() => {})
        }
        await tracker.stop?.().catch(() => {})
      }))
      throw rejectedInference.reason
    }
    const results = settledInference.map(item => item.value)
    if (results.some(result => result?.status === 'status_unknown')) {
      await Promise.all(results.map(async result => {
        if (!result?.tracker) return
        if (['result_ready', 'applying'].includes(String(result.tracker.status || ''))) {
          await result.tracker.completedStale('model_compare_peer_status_unknown').catch(() => {})
        }
        await result.tracker.stop?.().catch(() => {})
      }))
      return { status:'status_unknown', message:'history_compare_status_unknown' }
    }
    const persistCompletedUnit = async (result, modelSignal) => {
      if (result.checkpoint) return
      const terminalFailure = modelSignal.signal_type === 'error'
      try {
        if (terminalFailure && result.tracker
          && !['failed_terminal', 'completed_rejected', 'succeeded'].includes(String(result.tracker.status || ''))) {
          await result.tracker.failed({
            code:modelSignal.error || 'model_compare_inference_failed',
            message:modelSignal.error || 'model_compare_inference_failed',
          }, true)
          if (compareTrackerIsUnknown(result.tracker)) {
            throw Object.assign(new Error('history_compare_status_unknown'), { code:'history_compare_status_unknown' })
          }
        }
        await persistCheckpointState(result.modelId, {
          checkpoint_status:terminalFailure ? 'failed' : 'completed',
          error_code:modelSignal.error || null,
          result:modelSignal,
          telemetry:{ ...(result.telemetry || {}), model_task_id:result.tracker?.taskId || null },
          input_evidence:result.preparedEvidence || null,
        })
        if (!terminalFailure && result.tracker) {
          await result.tracker.succeeded({
            resultRef:`model_compare:${compareJobId}:${historyCompareCheckpointUnitKey(result.modelId, stepNumber)}`,
            resultHash:comparisonFingerprint(modelSignal),
          })
        }
      } catch (error) {
        if (result.tracker) await result.tracker.failed(error, true).catch(() => {})
        throw error
      } finally {
        await result.tracker?.stop?.().catch(() => {})
      }
    }
    for (const result of results) {
      if (result.checkpoint) {
        modelSignals[result.modelId].push(result.restoredSignal)
        continue
      }
      const outcomeKline = decisionPoint.outcomeKline
      const outcomeUtcMs = compareRateUtcMs(outcomeKline)
      const outcomeTime = outcomeUtcMs == null ? null : new Date(outcomeUtcMs).toISOString()
      const openPrice = Number(outcomeKline.open)
      const closePrice = Number(outcomeKline.close)

      if (result.error) {
        const modelSignal = {
          decision_time:new Date(decisionUtcMs).toISOString(), outcome_time:outcomeTime, time:outcomeTime,
          decision_time_utc_msc:decisionUtcMs, outcome_time_utc_msc:outcomeUtcMs,
          signal_type: 'error', decision_class:'model_error', confidence: 0, next_bar_move: 0,
          latency_ms: result.latencyMs || 0, error: result.error,
        }
        modelSignals[result.modelId].push(modelSignal)
        await persistCompletedUnit(result, modelSignal)
        continue
      }

      const signal = result.signal
      const inferenceSource = signal?._inference_source || 'unknown'
      if (inferenceSource !== 'ai') {
        const modelSignal = {
          decision_time:new Date(decisionUtcMs).toISOString(), outcome_time:outcomeTime, time:outcomeTime,
          decision_time_utc_msc:decisionUtcMs, outcome_time_utc_msc:outcomeUtcMs,
          signal_type: 'error', decision_class:'model_error', confidence: 0, next_bar_move: 0, latency_ms: result.latencyMs || 0,
          error: signal?.reasoning || 'inference_failed',
        }
        modelSignals[result.modelId].push(modelSignal)
        await persistCompletedUnit(result, modelSignal)
        continue
      }
      const direction = comparisonDirection(signal.signal_type)
      if (direction === 'unknown') {
        const modelSignal = {
          decision_time:new Date(decisionUtcMs).toISOString(), outcome_time:outcomeTime, time:outcomeTime,
          decision_time_utc_msc:decisionUtcMs, outcome_time_utc_msc:outcomeUtcMs,
          signal_type:'error', decision_class:'model_error', confidence:0, next_bar_move:0, latency_ms:result.latencyMs || 0,
          error:'invalid_model_signal_type',
        }
        modelSignals[result.modelId].push(modelSignal)
        await persistCompletedUnit(result, modelSignal)
        continue
      }
      let nextBarMove = 0
      if (direction === 'buy') nextBarMove = closePrice - openPrice
      else if (direction === 'sell') nextBarMove = openPrice - closePrice
      const comparisonValidation = signal.comparison_validation || null
      const executionValidation = signal.execution_validation || null
      const constraintInvalid = direction !== 'hold' && comparisonValidation?.status === 'invalid'
      const decisionClass = direction === 'hold' && signal.normalization_info
        ? 'system_downgraded'
        : direction === 'hold' ? 'model_hold'
          : constraintInvalid ? 'constraint_invalid' : 'actionable'
      const executionEligible = (direction === 'buy' || direction === 'sell')
        && comparisonValidation?.execution_eligible !== false
        && executionValidation?.eligible !== false

      const modelSignal = {
        decision_time:new Date(decisionUtcMs).toISOString(), outcome_time:outcomeTime, time:outcomeTime,
        decision_time_utc_msc:decisionUtcMs, outcome_time_utc_msc:outcomeUtcMs,
        signal_type: direction, decision_class:decisionClass,
        confidence: signal.confidence || 0, next_bar_move: nextBarMove,
        latency_ms: result.latencyMs || 0,
        normalization_info:signal.normalization_info || null,
        comparison_validation:comparisonValidation,
        execution_validation:executionValidation,
        execution_eligible:executionEligible,
        raw_model_direction:comparisonDirection(result.rawSignalType),
        policy_compliant_direction:null,
        workflow_compliant:null,
        constraint_passed:null,
        strategy_policy_mode:result.strategyDataRuntime?.mode || 'off',
        strategy_policy_hash:result.strategyDataRuntime?.policy_hash || null,
        strategy_data_runtime_version:result.strategyDataRuntime?.data_runtime_version || null,
        decision_summary:boundedComparisonError(signal.decision_summary || signal.analysis || '', '', 600),
        reasoning:boundedComparisonError(signal.reasoning || '', '', 800),
        snapshot_sample:decisionPoint.snapshotSample ? {
          snapshot_id:decisionPoint.snapshotSample.snapshot_id,
          signal_id:decisionPoint.snapshotSample.signal_id,
          strategy_version:decisionPoint.snapshotSample.strategy_version,
          original_signal_type:decisionPoint.snapshotSample.original_signal_type,
          original_net_profit:decisionPoint.snapshotSample.net_profit,
        } : null,
        order_intent: direction === 'buy' || direction === 'sell' ? {
          signal_type:signal.signal_type,
          entry_method:signal.entry_method,
          recommended_volume:signal.recommended_volume,
          limit_price:signal.limit_price,
          stop_limit_price:signal.stop_limit_price,
          pending_valid_minutes:signal.pending_valid_minutes,
          pending_valid_until:signal.pending_valid_until,
          stop_loss_price:signal.stop_loss_price,
          take_profit_1_price:signal.take_profit_1_price,
          take_profit_2_price:signal.take_profit_2_price,
          take_profit_3_price:signal.take_profit_3_price,
          recommended_take_profit_tier:signal.recommended_take_profit_tier,
        } : null,
      }
      modelSignals[result.modelId].push(modelSignal)
      await persistCompletedUnit(result, modelSignal)
    }
    await onProgress({
      stage: 'evaluating',
      progress_percent: 15 + Math.round(((stepNumber + 1) / Math.max(1, decisionPoints.length)) * 80),
      completed_steps: stepNumber + 1,
      total_steps: decisionPoints.length,
    })
  }

  let backtestContext = {
    status:'not_applicable',
    reason:'no_actionable_signals',
    execution_timeframe:'M1',
    execution_candles:[],
    instrument:null,
    account:null,
    market_source:null,
    timezone_offset_minutes:null,
  }
  const executableModelSignals = Object.fromEntries(Object.entries(modelSignals).map(([modelId, signals]) => [
    modelId,
    signals.filter(signal => signal.execution_eligible !== false
      && (signal.signal_type === 'buy' || signal.signal_type === 'sell')),
  ]))
  const hasExecutableSignals = Object.values(executableModelSignals).some(signals => signals.length > 0)
  if (hasExecutableSignals) {
    await onProgress({
      stage:'backtesting',
      progress_percent:96,
      completed_steps:decisionPoints.length,
      total_steps:decisionPoints.length,
    })
    const [executionResult, symbolResult] = await Promise.allSettled([
      loadHistoryExecutionCandles(userId, symbol,
        historyExecutionWindows(executableModelSignals, endUtcMs, backtestOptions.max_holding_hours)),
      loadHistorySymbolSnapshot(userId, symbol),
    ])
    const execution = executionResult.status === 'fulfilled' ? executionResult.value : null
    const snapshot = symbolResult.status === 'fulfilled' ? symbolResult.value : null
    if (execution?.candles?.length && snapshot?.status === 'success' && snapshot.instrument) {
      backtestContext = {
        status:'ready',
        reason:null,
        execution_timeframe:execution.timeframe,
        execution_candles:execution.candles,
        instrument:snapshot.instrument,
        account:snapshot.account || null,
        market_source:execution.marketSource,
        timezone_offset_minutes:execution.timezoneOffsetMinutes,
      }
    } else {
      backtestContext = {
        ...backtestContext,
        reason:executionResult.status === 'rejected'
          ? (executionResult.reason?.message || 'backtest_execution_candles_unavailable')
          : symbolResult.status === 'rejected'
            ? (symbolResult.reason?.message || 'backtest_symbol_snapshot_unavailable')
            : !execution?.candles?.length
              ? 'backtest_execution_candles_unavailable'
              : (snapshot?.message || snapshot?.error || 'backtest_symbol_snapshot_unavailable'),
      }
    }
  }

  const bridgeLeverage = Number(backtestContext.account?.leverage)
  const bridgeStopOut = Number(backtestContext.account?.margin_so_so)
  const bridgeStopOutUsesPercent = Number(backtestContext.account?.margin_so_mode || 0) === 0
  const useBridgeAccountSettings = params.backtest?.use_bridge_account_settings !== false
  const runtimeBacktestOptions = normalizeBacktestOptions({
    ...backtestOptions,
    leverage:useBridgeAccountSettings && bridgeLeverage > 0 ? bridgeLeverage : backtestOptions.leverage,
    stop_out_level_pct:useBridgeAccountSettings && bridgeStopOutUsesPercent && bridgeStopOut > 0
      ? bridgeStopOut
      : backtestOptions.stop_out_level_pct,
    timezone_offset_minutes:Number.isFinite(Number(backtestContext.timezone_offset_minutes))
      ? Number(backtestContext.timezone_offset_minutes)
      : backtestOptions.timezone_offset_minutes,
    account_currency:backtestContext.account?.currency || backtestOptions.account_currency,
  })

  const modelResults = []
  for (const { modelId, resolved } of validModels) {
    const signals = modelSignals[modelId]
    const totalMove = signals.reduce((sum, s) => sum + s.next_bar_move, 0)
    const buyCount = signals.filter(s => s.signal_type === 'buy').length
    const sellCount = signals.filter(s => s.signal_type === 'sell').length
    const holdCount = signals.filter(s => s.decision_class === 'model_hold').length
    const downgradedCount = signals.filter(s => s.decision_class === 'system_downgraded').length
    const constraintInvalidCount = signals.filter(s => s.decision_class === 'constraint_invalid').length
    const executableSignals = signals.filter(s => s.execution_eligible !== false
      && (s.signal_type === 'buy' || s.signal_type === 'sell'))
    const correctCount = signals.filter(s => s.next_bar_move > 0).length
    const incorrectCount = signals.filter(s => s.next_bar_move < 0).length
    const flatCount = signals.filter(s => ['buy', 'sell'].includes(s.signal_type) && s.next_bar_move === 0).length
    const errorCount = signals.filter(s => s.signal_type === 'error').length
    const tradeCount = buyCount + sellCount
    const successfulCount = tradeCount + holdCount
    const completedModelResponses = successfulCount + downgradedCount
    const responseSuccessRate = signals.length > 0 ? (successfulCount / signals.length) * 100 : 0
    const actionRate = successfulCount > 0 ? (tradeCount / successfulCount) * 100 : 0
    const confidenceSignals = signals.filter(s => ['actionable', 'constraint_invalid', 'model_hold'].includes(s.decision_class))
    const averageConfidence = confidenceSignals.length > 0
      ? confidenceSignals.reduce((sum, s) => sum + Number(s.confidence || 0), 0) / confidenceSignals.length
      : 0
    const averageLatency = signals.length > 0
      ? signals.reduce((sum, s) => sum + Number(s.latency_ms || 0), 0) / signals.length
      : 0
    const qualityScore = wilsonLowerBound(correctCount, tradeCount) * (0.7 + 0.3 * responseSuccessRate / 100) * 100
    const accountSimulation = backtestContext.status === 'ready'
      ? simulateVirtualAccount(executableSignals, backtestContext.execution_candles, backtestContext.instrument, runtimeBacktestOptions)
      : {
        status:'unavailable',
        reason:backtestContext.reason,
        options:runtimeBacktestOptions,
      }
    if (accountSimulation.status === 'success') {
      accountSimulation.execution_resolution = backtestContext.execution_timeframe
      accountSimulation.market_source = backtestContext.market_source
      accountSimulation.account_currency = backtestContext.account?.currency || backtestContext.instrument?.currency_profit || null
    }

    modelResults.push({
      model_id: modelId,
      model_name: resolved.model.model_name,
      provider: resolved.model.provider || resolved.model.api_provider,
      status: completedModelResponses > 0 ? 'success' : 'error',
      error: completedModelResponses > 0 ? null : 'model_compare_no_valid_response',
      signal_count: signals.length,
      signals,
      runtime_model:modelRuntimeSnapshots[modelId],
      provider_usage:{ ...modelTelemetry[modelId] },
      account_simulation:accountSimulation,
      directional_score: {
        total_move: Number(totalMove.toFixed(10)),
        correct_count: correctCount,
        incorrect_count: incorrectCount,
        flat_count: flatCount,
        directional_accuracy: tradeCount > 0 ? Number(((correctCount / tradeCount) * 100).toFixed(1)) : 0,
        direction_quality_score: Number(qualityScore.toFixed(1)),
        actionable_count: tradeCount,
        executable_count:executableSignals.length,
        action_rate: Number(actionRate.toFixed(1)),
        output_compliance_rate:signals.length > 0
          ? Number((((signals.length - constraintInvalidCount - downgradedCount - errorCount) / signals.length) * 100).toFixed(1))
          : 0,
        response_success_rate: Number(responseSuccessRate.toFixed(1)),
        average_confidence: Number((averageConfidence * 100).toFixed(1)),
        average_latency_ms: Math.round(averageLatency),
        avg_next_bar_move: tradeCount > 0 ? Number((totalMove / tradeCount).toFixed(10)) : 0,
        buy_count: buyCount,
        sell_count: sellCount,
        hold_count: holdCount,
        downgraded_count:downgradedCount,
        constraint_invalid_count:constraintInvalidCount,
        invalid_count:downgradedCount + constraintInvalidCount + errorCount,
        error_count: errorCount,
      },
    })
  }

  const agreementByStep = decisionPoints.map((_, index) => {
    const directions = modelResults.map(result => result.signals[index])
      .filter(signal => ['actionable', 'constraint_invalid', 'model_hold'].includes(signal?.decision_class))
      .map(signal => signal.signal_type)
    if (directions.length < 2) return null
    const counts = directions.reduce((acc, direction) => {
      acc[direction] = (acc[direction] || 0) + 1
      return acc
    }, {})
    const maximum = Math.max(0, ...Object.values(counts))
    return maximum / directions.length
  })
  const comparableAgreementSteps = agreementByStep.filter(value => value != null)
  const averageAgreement = comparableAgreementSteps.length
    ? comparableAgreementSteps.reduce((sum, value) => sum + value, 0) / comparableAgreementSteps.length
    : 0
  const successfulAccountReplay = modelResults.find(result => result.account_simulation?.status === 'success')
  const unavailableAccountReplay = modelResults.find(result => result.account_simulation?.status === 'unavailable')
  const accountSimulationStatus = successfulAccountReplay
    ? 'ready'
    : hasExecutableSignals ? 'unavailable' : 'not_applicable'
  const accountSimulationReason = successfulAccountReplay
    ? null
    : (unavailableAccountReplay?.account_simulation?.reason || backtestContext.reason)
  const providerUsageTotals = Object.values(modelTelemetry).reduce((total, item) => ({
    provider_request_count:total.provider_request_count + item.provider_request_count,
    repair_request_count:total.repair_request_count + item.repair_request_count,
    successful_request_count:total.successful_request_count + item.successful_request_count,
    failed_request_count:total.failed_request_count + item.failed_request_count,
    token_count:total.token_count + item.token_count,
  }), {
    provider_request_count:0,
    repair_request_count:0,
    successful_request_count:0,
    failed_request_count:0,
    token_count:0,
  })
  const reproducibilityEvidence = {
    run_version:'history-compare-v7',
    reproducibility_level:'input_auditable_model_nondeterministic',
    strategy:strategyRuntimeSnapshot,
    evaluator_strategy:dataSource === 'snapshots' ? strategyRuntimeSnapshot : null,
    models:Object.values(modelRuntimeSnapshots),
    market_data:marketDataEvidence,
    execution_data:comparisonRatesEvidence(
      backtestContext.execution_timeframe || 'M1',
      backtestContext.execution_candles,
    ),
    execution_contract_snapshot:backtestContext.status === 'ready' ? {
      instrument:backtestContext.instrument,
      account:{
        currency:backtestContext.account?.currency || null,
        leverage:Number(backtestContext.account?.leverage || 0),
        margin_so_mode:Number(backtestContext.account?.margin_so_mode || 0),
        margin_so_so:Number(backtestContext.account?.margin_so_so || 0),
      },
    } : null,
    decision_inputs:[...decisionInputEvidence.values()]
      .sort((a, b) => a.decision_time_utc_msc - b.decision_time_utc_msc),
    backtest_options:runtimeBacktestOptions,
    snapshot_selection:dataSource === 'snapshots' ? {
      fingerprint:snapshotRun.fingerprint,
      snapshot_ids:snapshotRun.snapshot_ids,
      strategy_version:snapshotRun.strategy_version,
      output_schema_version:snapshotRun.output_schema_version,
    } : null,
  }
  reproducibilityEvidence.evidence_sha256 = comparisonFingerprint(reproducibilityEvidence)

  return {
    status: 'success',
    results: [...modelResults, ...modelErrors],
    meta: {
      symbol, timeframe:requestedTimeframe, evaluation_timeframe:evaluationTimeframe,
      strategy_id:Number(strategy_id), data_source:dataSource,
      snapshot_selection:dataSource === 'snapshots' ? {
        fingerprint:snapshotRun.fingerprint,
        snapshot_ids:snapshotRun.snapshot_ids,
        strategy_version:snapshotRun.strategy_version,
      } : null,
      kline_count:dataSource === 'snapshots'
        ? snapshotModelInputKlineCount(snapshotRun.samples) || snapshotRun.samples.reduce((sum, sample) =>
          sum + Object.values(sample.klines || {}).reduce((count, rates) =>
            count + (Array.isArray(rates) ? rates.length : 0), 0), 0)
        : klines.length,
      model_input_kline_count:dataSource === 'snapshots'
        ? snapshotModelInputKlineCount(snapshotRun.samples)
        : klines.length,
      archived_visualization_kline_count:dataSource === 'snapshots'
        ? snapshotRun.samples.reduce((sum, sample) => sum + Object.values(sample.klines || {})
          .reduce((count, rates) => count + (Array.isArray(rates) ? rates.length : 0), 0), 0)
        : null,
      evaluation_mode:evaluationMode,
      sample_size:evaluationMode === 'sampled' ? decisionPoints.length : null,
      requested_step: step == null ? null : Math.max(1, Math.min(50, Number(step) || 10)),
      step:dataSource === 'historical' && steps.length > 1
        ? Math.round((steps[steps.length - 1] - steps[0]) / (steps.length - 1))
        : null,
      evaluation_count:decisionPoints.length,
      max_evaluation_count:evaluationMode === 'continuous'
        ? HISTORY_COMPARE_MAX_CONTINUOUS_STEPS
        : HISTORY_COMPARE_MAX_STEPS,
      estimated_model_calls:decisionPoints.length * validModels.length,
      actual_model_calls:providerUsageTotals.provider_request_count,
      repair_model_calls:providerUsageTotals.repair_request_count,
      successful_model_calls:providerUsageTotals.successful_request_count,
      failed_model_calls:providerUsageTotals.failed_request_count,
      model_token_count:providerUsageTotals.token_count,
      average_agreement_rate: Number((averageAgreement * 100).toFixed(1)),
      agreement_comparable_count: comparableAgreementSteps.length,
      agreement_insufficient_count: agreementByStep.length - comparableAgreementSteps.length,
      high_agreement_count: comparableAgreementSteps.filter(value => value >= 0.75).length,
      disagreement_count: comparableAgreementSteps.filter(value => value < 0.5).length,
      market_source:dataSource === 'snapshots' ? 'inference_snapshot' : selectedWindow?.window?.marketMeta?.source || null,
      start_time:dataSource === 'snapshots' ? normalizedTimeRange.startTime
        : compareRateUtcMs(klines[0]) == null ? null : new Date(compareRateUtcMs(klines[0])).toISOString(),
      end_time:dataSource === 'snapshots' ? normalizedTimeRange.endTime
        : compareRateUtcMs(klines.at(-1)) == null ? null : new Date(compareRateUtcMs(klines.at(-1))).toISOString(),
      metric_type:'next_evaluation_bar_direction',
      metric_version:'directional-eval-v4',
      account_simulation_type:'event_driven_virtual_account',
      account_simulation_version:'account-replay-v4',
      account_simulation_status:accountSimulationStatus,
      account_simulation_reason:accountSimulationReason,
      execution_timeframe:backtestContext.execution_timeframe,
      execution_timezone_offset_minutes:backtestContext.timezone_offset_minutes,
      selection_timezone_offset_minutes:selectionTimezoneOffsetMinutes,
      backtest_options:runtimeBacktestOptions,
      backtest_account_source:useBridgeAccountSettings
        && (bridgeLeverage > 0 || (bridgeStopOutUsesPercent && bridgeStopOut > 0))
        ? 'bridge_account_metadata'
        : 'configured_defaults',
      strategy_timeframes: snapshotRun ? snapshotTimeframes(snapshotRun.samples) : planItems.map(item => item.timeframe),
      chan_enabled: snapshotRun ? snapshotChanEnabled : policy.useChanAnalysis,
      reproducibility:reproducibilityEvidence,
    },
  }
}

const historyCompareJobs = new Map()

function safeCompareJson(value, fallback = null) {
  if (value == null || value === '') return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function compareJobUtcMs(value) {
  if (!value) return null
  if (value instanceof Date) return value.getTime()
  const raw = String(value).trim()
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T')
  const qualified = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)
    ? normalized
    : `${normalized}+08:00`
  const parsed = Date.parse(qualified)
  return Number.isFinite(parsed) ? parsed : null
}

function publicHistoryCompareJob(job, { includeResult = true } = {}) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress_percent: job.progress_percent,
    completed_steps: job.completed_steps,
    total_steps: job.total_steps,
    result: includeResult && job.status === 'succeeded' ? job.result : null,
    error: job.error,
    params: job.params || null,
    created_at: job.created_at,
    updated_at: job.updated_at,
    created_at_utc_msc:compareJobUtcMs(job.created_at),
    updated_at_utc_msc:compareJobUtcMs(job.updated_at),
  }
}

function historyCompareJobFromRow(row) {
  if (!row) return null
  return {
    id: String(row.id),
    user_id: Number(row.user_id),
    status: row.status,
    stage: row.stage,
    progress_percent: Number(row.progress_percent || 0),
    completed_steps: Number(row.completed_steps || 0),
    total_steps: Number(row.total_steps || 0),
    params: safeCompareJson(row.params_json, {}),
    checkpoint_manifest: safeCompareJson(row.checkpoint_manifest_json, null),
    result: safeCompareJson(row.result_json, null),
    error: row.error_code || null,
    cancel_requested: Boolean(row.cancel_requested),
    created_at: row.created_at,
    updated_at: row.updated_at,
    updated_at_ms:compareJobUtcMs(row.updated_at) || Date.now(),
  }
}

async function persistHistoryCompareJob(job, { insert = false } = {}) {
  const persistedError = job.error
    ? boundedComparisonError(job.error, 'history_compare_failed', 240)
    : null
  const values = [
    job.id, job.user_id, job.status, job.stage, job.progress_percent || 0,
    job.completed_steps || 0, job.total_steps || 0, JSON.stringify(job.params || {}),
    job.result ? JSON.stringify(job.result) : null, persistedError,
    job.cancel_requested ? 1 : 0,
  ]
  if (insert) {
    await queryRun(`INSERT INTO ai_model_compare_jobs
      (id, user_id, status, stage, progress_percent, completed_steps, total_steps,
       params_json, checkpoint_manifest_json, result_json, error_code, cancel_requested, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`, [
      ...values.slice(0, 8), job.checkpoint_manifest ? JSON.stringify(job.checkpoint_manifest) : null, ...values.slice(8),
    ])
    return
  }
  await queryRun(`UPDATE ai_model_compare_jobs SET status = ?, stage = ?, progress_percent = ?,
    completed_steps = ?, total_steps = ?, checkpoint_manifest_json = ?, result_json = ?, error_code = ?, cancel_requested = ?,
    completed_at = CASE WHEN ? IN ('succeeded','failed','cancelled') THEN NOW() ELSE completed_at END,
    updated_at = NOW() WHERE id = ? AND user_id = ?`, [
    job.status, job.stage, job.progress_percent || 0, job.completed_steps || 0, job.total_steps || 0,
    job.checkpoint_manifest ? JSON.stringify(job.checkpoint_manifest) : null,
    job.result ? JSON.stringify(job.result) : null, persistedError, job.cancel_requested ? 1 : 0,
    job.status, job.id, job.user_id,
  ])
}

const HISTORY_COMPARE_CHECKPOINT_VERSION = 1

function historyCompareCheckpointUnitKey(modelId, unitIndex) {
  return `${Number(unitIndex)}:${Number(modelId)}`
}

function historyCompareCheckpointFromRow(row) {
  if (!row) return null
  return {
    job_id:String(row.job_id),
    model_id:Number(row.model_id),
    unit_key:String(row.unit_key),
    unit_index:Number(row.unit_index),
    decision_time_utc_msc:Number(row.decision_time_utc_msc),
    outcome_time_utc_msc:row.outcome_time_utc_msc == null ? null : Number(row.outcome_time_utc_msc),
    snapshot_id:row.snapshot_id == null ? null : Number(row.snapshot_id),
    checkpoint_status:String(row.checkpoint_status || row.status || 'completed'),
    error_code:row.error_code == null ? null : String(row.error_code),
    strategy_fingerprint:String(row.strategy_fingerprint || ''),
    prompt_hash:String(row.prompt_hash || ''),
    snapshot_fingerprint:row.snapshot_fingerprint == null ? null : String(row.snapshot_fingerprint),
    model_config_fingerprint:String(row.model_config_fingerprint || ''),
    output_contract_hash:String(row.output_contract_hash || ''),
    market_evidence_hash:String(row.market_evidence_hash || ''),
    result:safeCompareJson(row.result_json, null),
    telemetry:safeCompareJson(row.telemetry_json, null) || {},
    input_evidence:safeCompareJson(row.input_evidence_json, null),
  }
}

async function loadHistoryCompareCheckpoints(jobId) {
  const rows = await queryAll(`SELECT * FROM ai_model_compare_checkpoints
    WHERE job_id = ? ORDER BY unit_index ASC, model_id ASC`, [String(jobId)])
  return (rows || []).map(historyCompareCheckpointFromRow).filter(Boolean)
}

async function persistHistoryCompareCheckpoint(jobId, checkpoint) {
  await queryRun(`INSERT INTO ai_model_compare_checkpoints
    (job_id, model_id, unit_key, unit_index, checkpoint_status, error_code, decision_time_utc_msc, outcome_time_utc_msc,
     snapshot_id, strategy_fingerprint, prompt_hash, snapshot_fingerprint, model_config_fingerprint,
     output_contract_hash, market_evidence_hash, result_json, telemetry_json, input_evidence_json,
     created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    ON DUPLICATE KEY UPDATE
      checkpoint_status = VALUES(checkpoint_status), error_code = VALUES(error_code),
      decision_time_utc_msc = VALUES(decision_time_utc_msc),
      outcome_time_utc_msc = VALUES(outcome_time_utc_msc),
      snapshot_id = VALUES(snapshot_id),
      strategy_fingerprint = VALUES(strategy_fingerprint),
      prompt_hash = VALUES(prompt_hash),
      snapshot_fingerprint = VALUES(snapshot_fingerprint),
      model_config_fingerprint = VALUES(model_config_fingerprint),
      output_contract_hash = VALUES(output_contract_hash),
      market_evidence_hash = VALUES(market_evidence_hash),
      result_json = VALUES(result_json), telemetry_json = VALUES(telemetry_json),
      input_evidence_json = VALUES(input_evidence_json), updated_at = NOW()`, [
    String(jobId), Number(checkpoint.model_id), String(checkpoint.unit_key), Number(checkpoint.unit_index),
    String(checkpoint.checkpoint_status || 'completed'), checkpoint.error_code == null
      ? null : boundedComparisonError(checkpoint.error_code, 'checkpoint_failed', 128),
    Number(checkpoint.decision_time_utc_msc), checkpoint.outcome_time_utc_msc == null ? null : Number(checkpoint.outcome_time_utc_msc),
    checkpoint.snapshot_id == null ? null : Number(checkpoint.snapshot_id), String(checkpoint.strategy_fingerprint || ''),
    String(checkpoint.prompt_hash || ''), checkpoint.snapshot_fingerprint == null ? null : String(checkpoint.snapshot_fingerprint),
    String(checkpoint.model_config_fingerprint || ''), String(checkpoint.output_contract_hash || ''),
    String(checkpoint.market_evidence_hash || ''), JSON.stringify(checkpoint.result || null),
    JSON.stringify(checkpoint.telemetry || {}), checkpoint.input_evidence ? JSON.stringify(checkpoint.input_evidence) : null,
  ])
}

function historyCompareCheckpointManifestFingerprint(manifest) {
  const { manifest_fingerprint: _ignored, ...content } = manifest || {}
  return comparisonFingerprint(content)
}

function buildHistoryCompareCheckpointManifest({ strategy, strategyRuntimeSnapshot, snapshotRun,
  dataSource, validModels, modelRuntimeSnapshots, decisionPoints, marketDataEvidence, prompt,
  memorySnapshot = null }) {
  const strategyFingerprint = strategyRuntimeSnapshot?.runtime_config_sha256
    || comparisonFingerprint(strategyRuntimeSnapshot || {})
  const promptHash = strategyRuntimeSnapshot?.system_prompt_sha256 || comparisonFingerprint(prompt || '')
  const snapshotFingerprint = snapshotRun?.fingerprint || null
  const modelConfigFingerprint = comparisonFingerprint(Object.values(modelRuntimeSnapshots || {})
    .map(model => model.runtime_config_sha256 || comparisonFingerprint(model)).sort())
  const outputContractHash = comparisonFingerprint({
    signal_schema_version:SIGNAL_SCHEMA_VERSION,
    comparison_run_version:'history-compare-v7',
    snapshot_output_schema_version:snapshotRun?.output_schema_version || null,
  })
  const marketEvidenceHash = comparisonFingerprint(marketDataEvidence || [])
  const units = (decisionPoints || []).map((point, unitIndex) => ({
    unit_index:unitIndex,
    decision_time_utc_msc:Number(point.decisionUtcMs),
    outcome_time_utc_msc:compareRateUtcMs(point.outcomeKline),
    snapshot_id:point.snapshotSample?.snapshot_id == null ? null : Number(point.snapshotSample.snapshot_id),
  }))
  const manifest = {
    version:HISTORY_COMPARE_CHECKPOINT_VERSION,
    data_source:dataSource,
    strategy_id:Number(strategy?.id || strategyRuntimeSnapshot?.strategy_id || 0),
    strategy_version:Number(strategyRuntimeSnapshot?.strategy_version || strategy?.version || 1),
    strategy_fingerprint:strategyFingerprint,
    prompt_hash:promptHash,
    snapshot_fingerprint:snapshotFingerprint,
    snapshot_ids:snapshotRun?.snapshot_ids || null,
    model_config_fingerprint:modelConfigFingerprint,
    models:Object.values(modelRuntimeSnapshots || {}).map(model => ({
      model_profile_id:Number(model.model_profile_id),
      model_config_fingerprint:model.runtime_config_sha256 || comparisonFingerprint(model),
    })).sort((a, b) => a.model_profile_id - b.model_profile_id),
    output_contract_hash:outputContractHash,
    market_evidence_hash:marketEvidenceHash,
    market_evidence:marketDataEvidence || [],
    units,
    ...(dataSource === 'historical' && memorySnapshot ? {
      memory_library_version_no:Number(memorySnapshot.version_no || 0),
      memory_library_content_hash:memorySnapshot.content_hash || null,
      memory_library_content_text:String(memorySnapshot.content_text || ''),
    } : {}),
  }
  return { ...manifest, manifest_fingerprint:historyCompareCheckpointManifestFingerprint(manifest) }
}

function historyCompareCheckpointManifestMatches(expected, actual) {
  if (!expected || !actual) return !expected && !actual
  return Number(expected.version) === Number(actual.version)
    && String(expected.manifest_fingerprint || '') === String(actual.manifest_fingerprint || '')
}

function historyCompareCheckpointMatchesManifest(checkpoint, manifest) {
  if (!checkpoint || !manifest) return false
  const model = (manifest.models || []).find(item => Number(item.model_profile_id) === Number(checkpoint.model_id))
  const unit = (manifest.units || [])[Number(checkpoint.unit_index)]
  return Boolean(model && unit)
    && checkpoint.unit_key === historyCompareCheckpointUnitKey(checkpoint.model_id, checkpoint.unit_index)
    && Number(checkpoint.decision_time_utc_msc) === Number(unit.decision_time_utc_msc)
    && Number(checkpoint.outcome_time_utc_msc || 0) === Number(unit.outcome_time_utc_msc || 0)
    && Number(checkpoint.snapshot_id || 0) === Number(unit.snapshot_id || 0)
    && checkpoint.strategy_fingerprint === manifest.strategy_fingerprint
    && checkpoint.prompt_hash === manifest.prompt_hash
    && checkpoint.snapshot_fingerprint === (manifest.snapshot_fingerprint || null)
    && checkpoint.model_config_fingerprint === model.model_config_fingerprint
    && checkpoint.output_contract_hash === manifest.output_contract_hash
    && checkpoint.market_evidence_hash === manifest.market_evidence_hash
}

function queueHistoryCompareJob(job) {
  if (!job || job.execution_queued || ['succeeded', 'failed', 'cancelled', 'status_unknown'].includes(job.status)) return
  job.execution_queued = true
  if (!job.abort_controller) job.abort_controller = new AbortController()
  queueMicrotask(async () => {
    job.execution_queued = false
    try {
      if (job.cancel_requested || job.status === 'cancelled') {
        job.status = 'cancelled'
        job.stage = 'cancelled'
        job.updated_at = new Date().toISOString()
        job.updated_at_ms = Date.now()
        try { await persistHistoryCompareJob(job) } finally { historyCompareJobs.delete(job.id) }
        return
      }
      job.status = 'running'
      job.stage = 'preparing'
      job.updated_at = new Date().toISOString()
      job.updated_at_ms = Date.now()
      await persistHistoryCompareJob(job)
      const checkpoints = await loadHistoryCompareCheckpoints(job.id)
      const result = await handleHistoryCompare(job.user_id, job.params, {
        shouldCancel: () => job.cancel_requested || job.abort_controller.signal.aborted,
        abortSignal:job.abort_controller.signal,
        checkpointManifest:job.checkpoint_manifest,
        checkpoints,
        jobId:job.id,
        onCheckpointManifest: async manifest => {
          job.checkpoint_manifest = manifest
          job.updated_at = new Date().toISOString()
          job.updated_at_ms = Date.now()
          await persistHistoryCompareJob(job)
        },
        onCheckpoint: checkpoint => persistHistoryCompareCheckpoint(job.id, checkpoint),
        onProgress: async progress => {
          Object.assign(job, progress, { updated_at: new Date().toISOString(), updated_at_ms: Date.now() })
          await persistHistoryCompareJob(job)
        },
      })
      if (job.cancel_requested || result.status === 'cancelled') {
        job.status = 'cancelled'
        job.stage = 'cancelled'
      } else if (result.status === 'success') {
        job.status = 'succeeded'
        job.stage = 'completed'
        job.progress_percent = 100
        job.result = result
      } else if (result.status === 'status_unknown') {
        job.status = 'status_unknown'
        job.stage = 'status_unknown'
        job.error = 'history_compare_status_unknown'
      } else {
        job.status = 'failed'
        job.stage = 'failed'
        job.error = boundedComparisonError(result.message)
      }
    } catch (error) {
      job.status = job.cancel_requested ? 'cancelled' : 'failed'
      job.stage = job.status
      job.error = job.cancel_requested ? null : boundedComparisonError(error.message)
    }
    job.updated_at = new Date().toISOString()
    job.updated_at_ms = Date.now()
    try {
      await persistHistoryCompareJob(job)
    } catch (error) {
      console.error(`[ModelCompare] Failed to persist final job state ${job.id}:`, error.message)
    } finally {
      if (['succeeded', 'failed', 'cancelled', 'status_unknown'].includes(job.status)) historyCompareJobs.delete(job.id)
    }
  })
}

async function reconcileInterruptedHistoryCompareJobs(userId) {
  const rows = await queryAll(`SELECT * FROM ai_model_compare_jobs
    WHERE user_id = ? AND status IN ('queued','running','cancelling')
      AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(params_json, '$.job_type')), 'history') <> 'live'`, [Number(userId)])
  for (const row of rows || []) {
    const stale = historyCompareJobFromRow(row)
    if (!stale || historyCompareJobs.has(stale.id)) continue
    stale.abort_controller = new AbortController()
    if (stale.status === 'cancelling' || stale.cancel_requested) {
      stale.cancel_requested = true
      stale.status = 'cancelled'
      stale.stage = 'cancelled'
      await persistHistoryCompareJob(stale)
      continue
    }
    historyCompareJobs.set(stale.id, stale)
    queueHistoryCompareJob(stale)
  }
}

export async function startHistoryCompareJobs() {
  await queryRun(`UPDATE ai_model_compare_jobs SET status = 'status_unknown', stage = 'status_unknown',
    error_code = 'live_compare_status_unknown_after_restart', completed_at = NOW(), updated_at = NOW()
    WHERE status IN ('queued','running','cancelling')
      AND JSON_UNQUOTE(JSON_EXTRACT(params_json, '$.job_type')) = 'live'`)
  const rows = await queryAll(`SELECT * FROM ai_model_compare_jobs
    WHERE status IN ('queued','running','cancelling')
      AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(params_json, '$.job_type')), 'history') <> 'live'
    ORDER BY created_at ASC`)
  for (const row of rows || []) {
    const job = historyCompareJobFromRow(row)
    if (!job || historyCompareJobs.has(job.id)) continue
    job.abort_controller = new AbortController()
    if (job.status === 'cancelling' || job.cancel_requested) {
      job.cancel_requested = true
      job.status = 'cancelled'
      job.stage = 'cancelled'
      await persistHistoryCompareJob(job)
      continue
    }
    historyCompareJobs.set(job.id, job)
    queueHistoryCompareJob(job)
  }
}

export const startHistoryCompareRecoveryWorker = startHistoryCompareJobs

export async function startHistoryCompareJob(userId, params) {
  const user = await queryOne('SELECT role FROM users WHERE id = ?', [userId])
  if (!user || user.role !== 'admin') throw new Error('admin_only')
  const strategy = params?.strategy_id
    ? await getStrategyById(Number(params.strategy_id), userId, 'admin', { forExecution:false })
    : null
  const dataSource = params?.data_source === 'snapshots' ? 'snapshots' : 'historical'
  const snapshotRun = dataSource === 'snapshots'
    ? await resolveModelSnapshotSelection(userId, params?.snapshot_ids, {
      strategy_id:params?.strategy_id,
      symbol:params?.symbol,
    })
    : null
  const strategyPolicy = strategy ? parseStrategyPolicy(strategy) : null
  const strategyPlanItems = strategyPolicy?.marketDataPlan?.timeframes?.map(item => ({
    timeframe:String(item.timeframe || '').toUpperCase(),
    kline_count:Math.max(20, Number(item.kline_count) || 100),
  })).filter(item => TIMEFRAME_MINUTES[item.timeframe]) || []
  const configuredEvaluationTimeframe = strategy
    ? resolveStrategyEvaluationTimeframe(strategy, strategyPlanItems)
    : null
  const snapshotEvaluationTimeframe = snapshotRun
    ? resolveLockedSnapshotEvaluationTimeframe(snapshotRun)
    : null
  const selectionTimezoneOffsetMinutes = await resolveCompareTimezoneOffset(params || {})
  const snapshotDecisions = snapshotRun?.samples.map(sample => snapshotDecisionPoint(
    sample, snapshotEvaluationTimeframe, selectionTimezoneOffsetMinutes,
  ).decisionUtcMs) || []
  const snapshotHoldingMs = normalizeBacktestOptions(params?.backtest || {}).max_holding_hours * 3_600_000
  const normalizedTimeRange = snapshotRun ? {
    startUtcMs:Math.min(...snapshotDecisions),
    endUtcMs:Math.min(Date.now(), Math.max(...snapshotDecisions) + snapshotHoldingMs + 60_000),
    startTime:new Date(Math.min(...snapshotDecisions)).toISOString(),
    endTime:new Date(Math.min(Date.now(), Math.max(...snapshotDecisions) + snapshotHoldingMs + 60_000)).toISOString(),
  } : normalizeHistoryCompareTimeRange(
    params?.start_time,
    params?.end_time,
    selectionTimezoneOffsetMinutes
  )
  const normalizedParams = {
    ...(params || {}),
    data_source:dataSource,
    snapshot_ids:snapshotRun?.snapshot_ids || null,
    snapshot_fingerprint:snapshotRun?.fingerprint || null,
    snapshot_strategy_version:snapshotRun?.strategy_version || null,
    snapshot_output_schema_version:snapshotRun?.output_schema_version || null,
    symbol:snapshotRun?.symbol || params?.symbol,
    start_time:normalizedTimeRange.startTime,
    end_time:normalizedTimeRange.endTime,
    timezone_offset_minutes:selectionTimezoneOffsetMinutes,
    evaluation_mode:dataSource === 'snapshots' ? 'sampled' : (params?.evaluation_mode == null ? 'sampled' : params.evaluation_mode),
    timeframe:snapshotRun ? snapshotPrimaryTimeframe(snapshotRun, strategyPolicy?.marketDataPlan?.primary_timeframe)
      : strategyPolicy?.marketDataPlan?.primary_timeframe || null,
    evaluation_timeframe:snapshotEvaluationTimeframe || configuredEvaluationTimeframe,
    backtest:{
      ...normalizeBacktestOptions(params?.backtest || {}),
      use_bridge_account_settings:params?.backtest?.use_bridge_account_settings !== false,
    },
  }
  await reconcileInterruptedHistoryCompareJobs(userId)
  const active = [...historyCompareJobs.values()].find(job => job.user_id === Number(userId)
    && ['queued', 'running', 'cancelling'].includes(job.status))
  if (active) {
    if (JSON.stringify(active.params) === JSON.stringify(normalizedParams)) return publicHistoryCompareJob(active)
    throw new Error('history_compare_job_already_running')
  }
  const now = new Date().toISOString()
  const job = {
    id: crypto.randomUUID(),
    user_id: Number(userId),
    status: 'queued',
    stage: 'queued',
    progress_percent: 0,
    completed_steps: 0,
    total_steps: 0,
    result: null,
    checkpoint_manifest: null,
    error: null,
    params:normalizedParams,
    cancel_requested: false,
    abort_controller:new AbortController(),
    created_at: now,
    updated_at: now,
    updated_at_ms: Date.now(),
  }
  historyCompareJobs.set(job.id, job)
  try {
    await persistHistoryCompareJob(job, { insert: true })
  } catch (error) {
    historyCompareJobs.delete(job.id)
    throw error
  }
  queueHistoryCompareJob(job)
  return publicHistoryCompareJob(job)
}

export async function getHistoryCompareJob(userId, jobId) {
  let job = historyCompareJobs.get(String(jobId))
  if (!job) {
    const row = await queryOne('SELECT * FROM ai_model_compare_jobs WHERE id = ? AND user_id = ?', [String(jobId), Number(userId)])
    job = historyCompareJobFromRow(row)
  }
  if (!job || job.user_id !== Number(userId) || job.params?.job_type === 'live') throw new Error('history_compare_job_not_found')
  if (['queued', 'running', 'cancelling'].includes(job.status) && !historyCompareJobs.has(job.id)) {
    job.abort_controller = new AbortController()
    historyCompareJobs.set(job.id, job)
    queueHistoryCompareJob(job)
  }
  return publicHistoryCompareJob(job)
}

export async function cancelHistoryCompareJob(userId, jobId) {
  let job = historyCompareJobs.get(String(jobId))
  if (!job) {
    const row = await queryOne('SELECT * FROM ai_model_compare_jobs WHERE id = ? AND user_id = ?', [String(jobId), Number(userId)])
    job = historyCompareJobFromRow(row)
    if (!job || job.user_id !== Number(userId) || job.params?.job_type === 'live') throw new Error('history_compare_job_not_found')
    if (['queued', 'running', 'cancelling'].includes(job.status)) {
      job.abort_controller = new AbortController()
      historyCompareJobs.set(job.id, job)
      queueHistoryCompareJob(job)
    }
  }
  if (job.user_id !== Number(userId) || job.params?.job_type === 'live') throw new Error('history_compare_job_not_found')
  if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return publicHistoryCompareJob(job)
  job.cancel_requested = true
  job.status = job.status === 'queued' ? 'cancelled' : 'cancelling'
  job.stage = job.status
  if (!job.abort_controller.signal.aborted) {
    job.abort_controller.abort(new Error('history_compare_cancelled'))
  }
  job.updated_at = new Date().toISOString()
  job.updated_at_ms = Date.now()
  await persistHistoryCompareJob(job)
  return publicHistoryCompareJob(job)
}

export async function listHistoryCompareJobs(userId, limit = 10) {
  const rows = await queryAll(`SELECT id, user_id, status, stage, progress_percent,
    completed_steps, total_steps, params_json, checkpoint_manifest_json, error_code, cancel_requested, created_at, updated_at
    FROM ai_model_compare_jobs WHERE user_id = ?
      AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(params_json, '$.job_type')), 'history') <> 'live'
    ORDER BY created_at DESC LIMIT ?`, [Number(userId), Math.max(1, Math.min(30, Number(limit) || 10))])
  const jobs = rows.map(historyCompareJobFromRow).filter(Boolean)
  for (const job of jobs) {
    if (['queued', 'running', 'cancelling'].includes(job.status) && !historyCompareJobs.has(job.id)) {
      job.abort_controller = new AbortController()
      historyCompareJobs.set(job.id, job)
      queueHistoryCompareJob(job)
    }
  }
  return jobs
    .map(job => publicHistoryCompareJob(job, { includeResult: false }))
}

export async function deleteHistoryCompareJob(userId, jobId) {
  const active = historyCompareJobs.get(String(jobId))
  if (active && ['queued', 'running', 'cancelling'].includes(active.status)) {
    return cancelHistoryCompareJob(userId, jobId)
  }
  await withTransaction(async run => {
    const [rows] = await run(`SELECT id FROM ai_model_compare_jobs
      WHERE id = ? AND user_id = ? AND status IN ('succeeded','failed','cancelled')
        AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(params_json, '$.job_type')), 'history') <> 'live' FOR UPDATE`,
    [String(jobId), Number(userId)])
    if (!rows?.[0]) throw new Error('history_compare_job_not_found')
    await run('DELETE FROM ai_model_compare_checkpoints WHERE job_id = ?', [String(jobId)])
    await run('DELETE FROM ai_model_compare_jobs WHERE id = ? AND user_id = ?',
      [String(jobId), Number(userId)])
  })
  historyCompareJobs.delete(String(jobId))
  return { id: String(jobId), status: 'deleted' }
}

export const __historyCompareJobsTest = {
  clear() {
    historyCompareJobs.clear()
  },
  executionWindows(modelSignals, endUtcMs, maxHoldingHours) {
    return historyExecutionWindows(modelSignals, endUtcMs, maxHoldingHours)
  },
  normalizeTimeRange(startTime, endTime, timezoneOffsetMinutes, nowMs) {
    return normalizeHistoryCompareTimeRange(startTime, endTime, timezoneOffsetMinutes, nowMs)
  },
  snapshotDecisionPoint(sample, evaluationTimeframe, timezoneOffsetMinutes) {
    return snapshotDecisionPoint(sample, evaluationTimeframe, timezoneOffsetMinutes)
  },
}
