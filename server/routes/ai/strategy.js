// ai/strategy.js — 策略上下文 + 执行 + 分析

import { queryOne, queryAll, queryRun, beijingNow, withTransaction } from '../../db.js'
import { isTradeEnabled, sendToBrowsers } from '../../bridge-ws.js'
import { STRATEGY_TIMEFRAME_COUNTS, CHAN_HISTORY_COUNT, CHAN_MAX_HISTORY_COUNT, attachSignalTiming, parseTimeframeTags, compactRates, signalTtlSeconds, stripBrokerSuffix } from './utils.js'
import { mt5Bridge, platformRates, calculateMarketData, computeAtr14 } from './market-data.js'
import { maybeAiSignal } from './llm.js'
import { getAnalyzeApiKey, insertAudit, RiskReject, signalOrderPayload, executeOrderCore, DEFAULT_MAX_POSITION_SIZE, parsePromptSymbols } from './config.js'
import { resolveOwnedModelProfileForRuntime } from './model-profiles.js'
import { retrievePersonalMemory, attachMemoryInjectionSignal, recordPairedInferenceRun, buildPersonalMemoryRetrievalContext } from './memory-system.js'
import { retrievePlatformExperience } from './platform-experience.js'
import { buildSharedMarketSnapshot, persistInferenceSnapshotTx } from './inference-snapshots.js'
import { getStrategyById } from './strategy-ownership.js'
import { parseStrategyPolicy } from './strategy-policy.js'
import { attachSignalPresentation, normalizeDecisionFields, SIGNAL_SCHEMA_VERSION } from './signal-presentation.js'
import { saveChanStructureAnchor } from './platform-market-data.js'
import { loadPeriodMarketWindow } from './period-market-evidence.js'
import { normalizeBacktestOptions, simulateVirtualAccount } from './model-backtest.js'
import crypto from 'node:crypto'

const ATR_ANCHOR_PRIORITY = ['H1', 'H4']
const CHAN_HISTORY_HINT_LIMIT = 512
const _chanMaxHistoryHints = new Map()
const TIMEFRAME_MINUTES = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440, W1: 10080 }
const HISTORY_COMPARE_MIN_CONTEXT = 20
const HISTORY_COMPARE_MAX_STEPS = 20
const HISTORY_COMPARE_MIN_STEPS = 4
const HISTORY_COMPARE_MAX_KLINES = 5000
const HISTORY_COMPARE_MAX_CONTINUOUS_STEPS = 120
const DEFAULT_MT5_TIMEZONE_OFFSET_MINUTES = 180

function normalizeCompareTimezoneOffset(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= -14 * 60 && numeric <= 14 * 60
    ? Math.trunc(numeric)
    : null
}

function timezoneOffsetSuffix(offsetMinutes) {
  const normalized = normalizeCompareTimezoneOffset(offsetMinutes) ?? DEFAULT_MT5_TIMEZONE_OFFSET_MINUTES
  const sign = normalized >= 0 ? '+' : '-'
  const absolute = Math.abs(normalized)
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
}

function parseCompareTimeUtcMs(value, timezoneOffsetMinutes = DEFAULT_MT5_TIMEZONE_OFFSET_MINUTES) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const hasTimezone = /T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)
  const normalized = raw.includes('T')
    ? raw
    : raw.includes(' ') ? raw.replace(' ', 'T') : `${raw}T00:00:00`
  const parsed = Date.parse(hasTimezone ? normalized : `${normalized}${timezoneOffsetSuffix(timezoneOffsetMinutes)}`)
  return Number.isFinite(parsed) ? parsed : null
}

async function resolveCompareTimezoneOffset(value) {
  const requested = normalizeCompareTimezoneOffset(value)
  if (requested != null) return requested
  const row = await queryOne(`SELECT mds.timezone_offset_minutes
    FROM market_data_sources mds JOIN users u ON u.id = mds.bridge_user_id
    WHERE u.role = 'admin' AND mds.timezone_offset_minutes IS NOT NULL
    ORDER BY (mds.clock_status = 'calibrated') DESC, mds.last_calibrated_at DESC, mds.id DESC LIMIT 1`)
  return normalizeCompareTimezoneOffset(row?.timezone_offset_minutes) ?? DEFAULT_MT5_TIMEZONE_OFFSET_MINUTES
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
    max_tokens:Number(model.max_tokens || 0),
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

function compareVisibleRates(rates, decisionUtcMs, timeframe, count, includeChan) {
  const durationMs = (TIMEFRAME_MINUTES[timeframe] || 1) * 60_000
  const closed = rates.filter(rate => {
    const openUtcMs = compareRateUtcMs(rate)
    return openUtcMs != null && openUtcMs + durationMs <= decisionUtcMs
  })
  const requested = Math.max(Number(count) || 100, includeChan ? CHAN_HISTORY_COUNT : 0)
  return closed.slice(-Math.min(requested, CHAN_MAX_HISTORY_COUNT))
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

function rememberChanMaxHistory(key) {
  _chanMaxHistoryHints.delete(key)
  _chanMaxHistoryHints.set(key, true)
  if (_chanMaxHistoryHints.size > CHAN_HISTORY_HINT_LIMIT) {
    _chanMaxHistoryHints.delete(_chanMaxHistoryHints.keys().next().value)
  }
}

function clearChanHistoryHints() {
  _chanMaxHistoryHints.clear()
}

function chanHistoryHintKey(userId, symbol, timeframe) {
  return `${userId}:${String(symbol).toUpperCase()}:${String(timeframe).toUpperCase()}`
}

export function resolveChanHistoryCount(userId, symbol, timeframe, requestedCount, useChan) {
  if (!useChan) return requestedCount
  const preferred = _chanMaxHistoryHints.has(chanHistoryHintKey(userId, symbol, timeframe))
    ? CHAN_MAX_HISTORY_COUNT
    : CHAN_HISTORY_COUNT
  return Math.max(requestedCount, preferred)
}

export function buildChanTimeframeAlignment(timeframes, primaryTimeframe, contextStatus = 'complete') {
  const frames = Object.entries(timeframes || {})
    .map(([timeframe, value]) => ({ timeframe, chan: value?.summary?.chan }))
    .filter(item => item.chan?.trend_state && item.chan.trend_state.state !== 'unavailable')
    .sort((a, b) => (TIMEFRAME_MINUTES[b.timeframe] || 0) - (TIMEFRAME_MINUTES[a.timeframe] || 0))
  const reliableFrames = frames.filter(item => item.chan.reliability !== 'low')
  const higher = reliableFrames[0] || frames[0] || null
  const directional = reliableFrames.filter(item => ['up', 'down'].includes(item.chan.trend_state?.direction))
  const directions = new Set(directional.map(item => item.chan.trend_state.direction))
  let agreement = 'insufficient'
  let direction = 'neutral'
  if (directional.length >= 2 && directions.size === 1) {
    direction = directional[0].chan.trend_state.direction
    agreement = direction === 'up' ? 'aligned_up' : 'aligned_down'
  } else if (directions.size > 1) {
    agreement = 'mixed'
  } else if (directional.length === 1) {
    direction = directional[0].chan.trend_state.direction
  }
  const higherDirection = reliableFrames.length > 0 ? higher?.chan?.trend_state?.direction || 'neutral' : 'neutral'
  const candidates = frames.flatMap(frame => (frame.chan.entry_candidates || []).map(candidate => {
    const candidateDirection = candidate.side === 'buy' ? 'up' : 'down'
    return {
      timeframe: frame.timeframe,
      ...candidate,
      alignment_with_higher: higherDirection === 'neutral'
        ? 'unconfirmed'
        : candidateDirection === higherDirection ? 'aligned' : 'conflict',
    }
  }))
  return {
    status: frames.length === 0 ? 'unavailable' : contextStatus === 'partial' ? 'partial' : 'complete',
    primary_timeframe: String(primaryTimeframe || '').toUpperCase() || null,
    higher_timeframe: higher?.timeframe || null,
    higher_timeframe_direction: higherDirection,
    higher_timeframe_phase: reliableFrames.length > 0 ? higher?.chan?.trend_state?.phase || 'unknown' : 'unknown',
    agreement,
    direction,
    conflict: agreement === 'mixed',
    usable_timeframes: reliableFrames.map(item => item.timeframe),
    excluded_low_reliability_timeframes: frames.filter(item => item.chan.reliability === 'low').map(item => item.timeframe),
    frames: frames.map(item => ({
      timeframe: item.timeframe,
      reliability: item.chan.reliability,
      state: item.chan.trend_state.state,
      direction: item.chan.trend_state.direction,
      phase: item.chan.trend_state.phase,
      reversal_bias: item.chan.trend_state.reversal_bias,
    })),
    entry_candidates: candidates,
    execution_policy: 'evidence_only',
  }
}

export const __strategyTest = { clearChanHistoryHints, buildChanTimeframeAlignment }

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

export async function buildStrategyContext(userId, symbol, account, positions, primaryTimeframe, primaryRates) {
  const timeframes = {}
  for (const [tf, count] of Object.entries(STRATEGY_TIMEFRAME_COUNTS)) {
    let rates
    if (tf === primaryTimeframe.toUpperCase() && primaryRates.length >= count) {
      rates = primaryRates
    } else {
      const resp = await platformRates(userId, { symbol, timeframe: tf, count })
      rates = (resp && resp.rates) ? resp.rates : []
    }
    const summary = calculateMarketData(symbol, tf, rates, account, positions, { computeChan: false })
    if (summary.error) continue
    const { account: _acct, positions: _pos, symbol: _sym, timeframe: _tf, timestamp: _ts, ...slimSummary } = summary
    timeframes[tf] = { summary: slimSummary, klines: compactRates(rates) }
  }
  return {
    strategy_sequence: '1H trend primary, 4H fallback only if 1H unclear, M15 signal confirmation, M5 precise entry trigger',
    required_timeframes: Object.keys(STRATEGY_TIMEFRAME_COUNTS),
    timeframes,
  }
}

export async function buildStrategyContextFromTags(userId, symbol, account, positions, prompt, fallbackTimeframe, fallbackRates, mode = 'manual', marketDataPlan = null, useChanAnalysis = null, fallbackMarketMeta = null) {
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
  const missingTimeframes = []
  for (const { tf, count } of tags) {
    const historyHintKey = chanHistoryHintKey(userId, symbol, tf)
    const historyCount = resolveChanHistoryCount(userId, symbol, tf, count, useChan)
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
      computeChan: useChan,
      chanRates: rates,
      requestedChanHistoryCount: historyCount,
      chanDataQuality,
    })
    const chanNeedsMoreHistory = summary.chan && (summary.chan.segment_count === 0 || summary.chan.center_count === 0)
    if (useChan && historyCount < CHAN_MAX_HISTORY_COUNT && (rates.length < historyCount || chanNeedsMoreHistory)) {
      rememberChanMaxHistory(historyHintKey)
      if (rates.length < CHAN_MAX_HISTORY_COUNT) {
        const retry = await platformRates(userId, { symbol, timeframe: tf, count: CHAN_MAX_HISTORY_COUNT })
        const retryRates = retry?.rates || []
        if (retryRates.length > rates.length) {
          rates = retryRates
          chanDataQuality = retry?.market_meta || chanDataQuality
          visibleRates = rates.slice(-count)
          summary = calculateMarketData(symbol, tf, visibleRates, account, positions, {
            computeChan: true,
            chanRates: rates,
            requestedChanHistoryCount: CHAN_MAX_HISTORY_COUNT,
            chanDataQuality,
          })
        }
      }
    }
    if (useChan && summary.chan?.structure_anchor?.recommended_time_utc_msc && chanDataQuality?.source_id) {
      await saveChanStructureAnchor(chanDataQuality.source_id, symbol, tf, summary.chan.structure_anchor).catch(error => {
        console.warn(`[Chan] Failed to persist structure anchor for ${symbol} ${tf}: ${error.message}`)
      })
    }
    const { account: _acct, positions: _pos, symbol: _sym, timeframe: _tf, timestamp: _ts, ...slimSummary } = summary
    timeframes[tf] = { summary: slimSummary, klines: compactRates(visibleRates) }
    if (useChan) visualizationKlines[tf] = compactRates(rates)
  }
  const context = {
    strategy_sequence: tags.map(t => `${t.tf}(${t.count})`).join(' → '),
    required_timeframes: tags.map(t => t.tf),
    used_timeframes: Object.keys(timeframes),
    missing_timeframes: missingTimeframes,
    context_status: missingTimeframes.length === 0 ? 'complete' : 'partial',
    ...(useChan ? { chan_timeframe_alignment: buildChanTimeframeAlignment(timeframes, fallbackTimeframe, missingTimeframes.length === 0 ? 'complete' : 'partial') } : {}),
    timeframes,
  }
  // Snapshot-only evidence: keep it out of model payloads, ai_signals JSON and
  // ordinary WebSocket responses. prepareInferenceSnapshot reads it directly.
  if (useChan) Object.defineProperty(context, 'visualization_klines', { value: visualizationKlines, enumerable: false })
  return context
}

export async function executeOrder(userId, config, request, action, options = {}) {
  return executeOrderCore(userId, config, request, action, options)
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

export async function handleAnalyze(userId, params) {
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
  config._allowed_entry_methods = policy.entryMethods
  config._market_data_plan = policy.marketDataPlan
  config._use_chan_analysis = policy.useChanAnalysis
  config._ai_volume_min = 0.01
  config._ai_volume_max = Number(config.max_position_size ?? DEFAULT_MAX_POSITION_SIZE)
  config._ai_volume_step = 0.01
  config.enable_auto_trade = Boolean(auto_execute)
  config._market_only = strategy.scope === 'platform'
  config._include_portfolio_context = strategy.scope === 'private' && Boolean(Number(strategy.include_portfolio_context))
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
  market.strategy_context = await buildStrategyContextFromTags(userId, symbol, account, positions, prompt, primaryTf, rates, 'manual', policy.marketDataPlan, policy.useChanAnalysis, ratesResp.market_meta)
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
      marketSource: ratesResp.market_meta?.source || 'platform_admin_bridge',
    })
  }
  let memory = { promptBlock: '', mode: 'off', logId: null }
  try {
    if (strategy.scope === 'platform') {
      memory = await retrievePlatformExperience({ strategyId: Number(strategy.id), strategyVersion:Number(strategy.version || 1), symbol, timeframe: primaryTf,
        market, allowedEntryMethods:policy.entryMethods })
    } else {
      const retrievalContext = buildPersonalMemoryRetrievalContext(market, primaryTf, policy.entryMethods)
      memory = await retrievePersonalMemory({ userId, strategyId: Number(strategy.id), strategyVersion: Number(strategy.version || 1),
        symbol, timeframe: primaryTf, direction: retrievalContext.direction,
        entryMethod: retrievalContext.entryMethod, marketRegime: retrievalContext.marketRegime,
        mode: params.memory_mode === 'shadow' ? 'shadow' : 'active' })
    }
  } catch (error) {
    console.error('[Analyze] Experience retrieval failed; continuing without it:', error.message)
  }
  if (config) {
    if (strategy.scope === 'platform') config._platformExperienceContext = memory.promptBlock
    else config._memoryContext = memory.promptBlock
    config._experienceSelection = { source:strategy.scope === 'platform' ? 'platform' : 'personal',
      selectedItemIds:memory.promptBlock ? (memory.selectedItemIds || []) : [],
      selectionDetails:memory.promptBlock ? (memory.selectionDetails || []) : [] }
    config._memoryMode = strategy.scope === 'platform' ? `platform_${memory.mode || 'off'}` : (memory.mode || 'off')
  }
  let renderedEvidence = null
  if (config) config._onInferencePrepared = evidence => { renderedEvidence = evidence }
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
  delete signal._inference_source

  const createdAt = beijingNow()
  const marketJson = JSON.stringify(market)
  const decision = normalizeDecisionFields(signal)
  const decisionJson = JSON.stringify(decision)
  const tokenCount = Math.round(((signal.analysis || '').length + (signal.reasoning || '').length + marketJson.length) / 4)
  if (!renderedEvidence) throw new Error('inference_evidence_missing')
  const persisted = await withTransaction(async run => {
    const [result] = await run(`INSERT INTO ai_signals(user_id, prompt_type_id, source, session_id, symbol, timeframe, signal_type, confidence, recommended_volume,
      analysis, reasoning, stop_loss_price, take_profit_1_price, take_profit_2_price, take_profit_3_price, recommended_take_profit_tier,
      market_data_json, token_count, ai_model, ttl_seconds, created_at,
      entry_method, limit_price, stop_limit_price, pending_valid_until, schema_version, decision_json)
      VALUES (?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, Number(strategy.id), session_id, symbol, primaryTf, signal.signal_type, signal.confidence, signal.recommended_volume,
        signal.analysis, signal.reasoning, signal.stop_loss_price || null,
        signal.take_profit_1_price || null, signal.take_profit_2_price || null, signal.take_profit_3_price || null,
        signal.recommended_take_profit_tier || null,
        marketJson, tokenCount, (config || {}).model_name || 'deepseek-chat', signalTtlSeconds(primaryTf), createdAt,
        signal.entry_method || 'market', signal.limit_price || null, signal.stop_limit_price || null, signal.pending_valid_until || null,
        SIGNAL_SCHEMA_VERSION, decisionJson])
    const snapshotId = await persistInferenceSnapshotTx(run, {
      signalId: result.insertId, strategyId: Number(strategy.id), strategyVersion: Number(strategy.version || 1), strategyScope: strategy.scope, ownerUserId: Number(strategy.owner_user_id || 0),
      standardSymbol: stripBrokerSuffix(symbol).toUpperCase(), marketSource: ratesResp.market_meta?.source || 'platform_admin_bridge',
      systemPrompt: renderedEvidence.systemPrompt, userPrompt: renderedEvidence.userPrompt,
      outputSchemaVersion: renderedEvidence.outputSchemaVersion, marketSnapshot: market,
      modelProfileId: config?._model_profile_id, provider: config?.api_provider,
      modelName: config?.model_name, credentialSource: config?._credential_source,
      memoryMode: strategy.scope === 'platform' ? `platform_${memory.mode || 'off'}` : (memory.mode || 'off'), createdAt,
    })
    return { signalId: result.insertId, snapshotId }
  })

  signal.id = persisted.signalId
  if (strategy.scope === 'private' && memory.logId) {
    try { await attachMemoryInjectionSignal(memory.logId, userId, signal.id, persisted.snapshotId) }
    catch (error) { console.error('[Analyze] Memory injection attribution failed:', error.message) }
  }
  signal.symbol = symbol
  signal.user_id = userId
  signal.timeframe = primaryTf
  signal.created_at = createdAt
  signal.market_data = market
  signal.is_executed = false
  attachSignalTiming(signal, ratesResp.market_meta?.timezone_offset_minutes)
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
    if (!isTradeEnabled(userId)) {
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

      const execResult = await executeOrder(userId, riskCfg, orderPayload, 'ai_execute', { sourceType: 'manual_ai' })
      signal.execution_result = execResult
      await queryRun('UPDATE ai_signals SET execution_result = ? WHERE id = ?', [JSON.stringify(execResult || {}), signal.id])
      if (execResult && execResult.status === 'success') {
        const isPending = orderPayload.entry_method && orderPayload.entry_method !== 'market' && orderPayload.entry_method !== 'observe'
        const ticket = execResult.order || execResult.ticket || null
        if (isPending) {
          await queryRun('UPDATE ai_signals SET pending_ticket = ?, pending_state = ? WHERE id = ?',
            [String(ticket), 'pending', signal.id])
          signal.pending_ticket = String(ticket)
          signal.pending_state = 'pending'
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

  if (strategy.scope === 'private' && memory.pairedExperimentEnabled && memory.mode === 'active' && memory.promptBlock) {
    let control = null
    let pairStatus = 'failed'
    let pairError = null
    try {
      const controlConfig = { ...config, _memoryContext: '', _memoryMode: 'off' }
      delete controlConfig._onInferencePrepared
      control = await maybeAiSignal(null, controlConfig, market, prompt)
      const controlSource = control?._inference_source
      if (control) delete control._inference_source
      pairStatus = controlSource === 'ai' ? 'succeeded' : 'failed'
      pairError = pairStatus === 'failed' ? (control?.reasoning || 'paired_control_failed') : null
    } catch (error) {
      pairError = error.message || 'paired_control_failed'
    }
    try {
      await recordPairedInferenceRun({ userId, strategyId: Number(strategy.id), signalId: signal.id,
        memoryLogId: memory.logId, treatment: signal, control, status: pairStatus, errorCode: pairError })
    } catch (error) {
      console.error('[Analyze] Paired inference evidence write failed:', error.message)
    }
  }

  signal = attachSignalPresentation(signal)
  return { status: 'success', signal, market }
}

export async function handleAnalyzeCompare(userId, params) {
  const { symbol, model_ids, strategy_id } = params
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

  const supportedSymbols = new Set(parsePromptSymbols(strategy.symbols_json).map(item => stripBrokerSuffix(String(item)).toUpperCase()))
  if (!supportedSymbols.has(stripBrokerSuffix(symbol).toUpperCase())) return { ok: false, error: 'symbol_not_supported_by_strategy' }

  const prompt = strategy.system_prompt || ''
  const policy = parseStrategyPolicy(strategy)
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
  market.strategy_context = await buildStrategyContextFromTags(userId, symbol, null, [], prompt, primaryTf, rates, 'manual', policy.marketDataPlan, policy.useChanAnalysis, ratesResp.market_meta)
  market.requested_timeframes = market.strategy_context.required_timeframes
  market.used_timeframes = market.strategy_context.used_timeframes
  market.missing_timeframes = market.strategy_context.missing_timeframes
  await attachAtrAnchor(userId, symbol, market, primaryTf)
  if (strategy.scope === 'platform') {
    market = buildSharedMarketSnapshot(market, {
      standardSymbol: symbol,
      volumeMin: 0.01,
      volumeMax: 1.0,
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

  const inferenceTasks = validModels.map(({ modelId, resolved }) => {
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
      _ai_volume_min: 0.01,
      _ai_volume_max: 1.0,
      _ai_volume_step: 0.01,
    }
    return maybeAiSignal(null, config, market, prompt).then(signal => {
      const inferenceSource = signal?._inference_source || 'unknown'
      if (inferenceSource !== 'ai') {
        return { model_id: modelId, status: 'error', error: signal?.reasoning || 'inference_failed' }
      }
      delete signal._inference_source
      const profile = resolved.model
      return {
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
      }
    }).catch(error => {
      return { model_id: modelId, status: 'error', error: error.message || 'inference_failed' }
    })
  })

  const inferenceResults = await Promise.all(inferenceTasks)
  for (const r of inferenceResults) {
    results.push(r)
  }

  const models = Object.fromEntries(validModels.map(({ modelId, resolved }) => [modelId, {
    model_name: resolved.model.model_name,
    provider: resolved.model.provider || resolved.model.api_provider,
  }]))
  return { ok: true, results, models, market_snapshot: market }
}

export async function handleHistoryCompare(userId, params, options = {}) {
  const { symbol, model_ids, strategy_id, start_time, end_time, step, sample_size } = params
  const evaluationMode = params.evaluation_mode == null || params.evaluation_mode === 'sampled'
    ? 'sampled'
    : params.evaluation_mode === 'continuous' ? 'continuous' : null
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : async () => {}
  const shouldCancel = typeof options.shouldCancel === 'function' ? options.shouldCancel : () => false
  const abortSignal = options.abortSignal || null

  const user = await queryOne('SELECT role FROM users WHERE id = ?', [userId])
  if (!user || user.role !== 'admin') return { status: 'error', message: 'admin_only' }
  const modelOwnerId = 0
  if (!symbol) return { status: 'error', message: 'symbol required' }
  if (!strategy_id) return { status: 'error', message: 'strategy required' }
  if (!start_time || !end_time) return { status: 'error', message: 'start_time and end_time required' }
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

  const supportedSymbols = new Set(parsePromptSymbols(strategy.symbols_json).map(item => stripBrokerSuffix(String(item)).toUpperCase()))
  if (!supportedSymbols.has(stripBrokerSuffix(symbol).toUpperCase())) return { status: 'error', message: 'symbol_not_supported_by_strategy' }
  const policy = parseStrategyPolicy(strategy)
  const planItems = policy.marketDataPlan.timeframes.map(item => ({
    timeframe: String(item.timeframe || '').toUpperCase(),
    kline_count: Math.max(20, Number(item.kline_count) || 100),
  })).filter(item => TIMEFRAME_MINUTES[item.timeframe])
  const requestedTimeframe = String(policy.marketDataPlan.primary_timeframe || planItems[0]?.timeframe || '').toUpperCase()
  if (!requestedTimeframe || !planItems.some(item => item.timeframe === requestedTimeframe)) {
    return { status: 'error', message: 'strategy_primary_timeframe_invalid' }
  }
  const backtestOptions = normalizeBacktestOptions(params.backtest || {})
  const strategyRuntimeSnapshot = {
    strategy_id:Number(strategy.id),
    strategy_version:Number(strategy.version || 1),
    scope:strategy.scope || null,
    system_prompt_sha256:comparisonFingerprint(strategy.system_prompt || ''),
    market_data_plan:policy.marketDataPlan,
    entry_methods:policy.entryMethods,
    use_chan_analysis:Boolean(policy.useChanAnalysis),
  }
  strategyRuntimeSnapshot.runtime_config_sha256 = comparisonFingerprint(strategyRuntimeSnapshot)

  const selectionTimezoneOffsetMinutes = await resolveCompareTimezoneOffset(params.timezone_offset_minutes)
  const startUtcMs = parseCompareTimeUtcMs(start_time, selectionTimezoneOffsetMinutes)
  const endUtcMs = parseCompareTimeUtcMs(end_time, selectionTimezoneOffsetMinutes)
  if (!startUtcMs || !endUtcMs || endUtcMs <= startUtcMs) {
    return { status: 'error', message: 'invalid_history_time_range' }
  }
  const warmupMs = planItems.reduce((max, item) => Math.max(max,
    TIMEFRAME_MINUTES[item.timeframe] * item.kline_count * 2 * 60_000), 0)
  let historyWindows
  try {
    historyWindows = await Promise.all(planItems.map(async item => ({
      ...item,
      window: await loadPeriodMarketWindow(userId, symbol, item.timeframe, startUtcMs - warmupMs, endUtcMs, {
        alignToPeriodStart: false,
      }),
    })))
  } catch (error) {
    return { status: 'error', message: error.message || 'history_market_data_unavailable' }
  }
  const marketDataEvidence = historyWindows.map(item =>
    comparisonRatesEvidence(item.timeframe, item.window?.periodRates))
  const selectedWindow = historyWindows.find(item => item.timeframe === requestedTimeframe)
  const primaryDurationMs = (TIMEFRAME_MINUTES[requestedTimeframe] || 1) * 60_000
  const evaluationCutoffUtcMs = Math.min(endUtcMs, Date.now())
  const requestedRates = Array.isArray(selectedWindow?.window?.periodRates)
    ? selectedWindow.window.periodRates.filter(rate => {
      const utcMs = compareRateUtcMs(rate)
      return utcMs != null && utcMs >= startUtcMs
        && utcMs + primaryDurationMs <= evaluationCutoffUtcMs
    })
    : []
  if (requestedRates.length > HISTORY_COMPARE_MAX_KLINES) {
    return { status: 'error', message: 'history_compare_range_too_large' }
  }
  const klines = requestedRates
  if (evaluationMode === 'sampled' && klines.length <= HISTORY_COMPARE_MIN_CONTEXT) {
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
  const steps = evaluationMode === 'continuous'
    ? buildContinuousHistoryCompareSteps(klines.length)
    : buildHistoryCompareSteps(klines.length, requestedSampleSize)
  if (evaluationMode === 'continuous' && steps.length > HISTORY_COMPARE_MAX_CONTINUOUS_STEPS) {
    return {
      status:'error',
      message:'continuous_backtest_range_too_large',
      evaluation_count:steps.length,
      max_evaluation_count:HISTORY_COMPARE_MAX_CONTINUOUS_STEPS,
    }
  }

  // Validate every decision point before resolving or calling any model. A
  // continuous backtest is only meaningful when all strategy timeframes have
  // the minimum closed-candle context at every evaluated primary-bar close.
  for (const stepIdx of steps) {
    const currentRateUtcMs = compareRateUtcMs(klines[stepIdx])
    const decisionUtcMs = currentRateUtcMs + (TIMEFRAME_MINUTES[requestedTimeframe] || 1) * 60_000
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
  const modelTelemetry = Object.fromEntries(validModels.map(({ modelId }) => [modelId, {
    provider_request_count:0,
    repair_request_count:0,
    successful_request_count:0,
    failed_request_count:0,
    token_count:0,
  }]))
  const decisionInputEvidence = new Map()

  await onProgress({ stage: 'models_ready', progress_percent: 15, completed_steps: 0, total_steps: steps.length })

  for (let stepNumber = 0; stepNumber < steps.length; stepNumber++) {
    if (shouldCancel()) return { status: 'cancelled', message: 'history_compare_cancelled' }
    const stepIdx = steps[stepNumber]
    const currentRateUtcMs = compareRateUtcMs(klines[stepIdx])
    const decisionUtcMs = currentRateUtcMs + (TIMEFRAME_MINUTES[requestedTimeframe] || 1) * 60_000
    const strategyTimeframes = {}
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
        requestedChanHistoryCount: contextRates.length,
        chanDataQuality: historicalDataQuality,
      })
      const { account: _account, positions: _positions, symbol: _symbol, timeframe: _timeframe, timestamp: _timestamp, ...slimSummary } = summary
      strategyTimeframes[item.timeframe] = { summary: slimSummary, klines: compactRates(visibleContextRates) }
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
    const market = calculateMarketData(symbol, requestedTimeframe, primaryRates.slice(-selectedWindow.kline_count), null, [], {
      computeChan: policy.useChanAnalysis,
      chanRates: primaryRates,
      requestedChanHistoryCount: primaryRates.length,
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
    market.requested_timeframes = market.strategy_context.required_timeframes
    market.used_timeframes = market.strategy_context.used_timeframes
    market.missing_timeframes = missingTimeframes
    if (policy.useChanAnalysis) market.chan = strategyTimeframes[requestedTimeframe]?.summary?.chan

    const inferenceTasks = validModels.map(async ({ modelId, resolved }) => {
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
        _ai_volume_min: 0.01,
        _ai_volume_max: 1.0,
        _ai_volume_step: 0.01,
        _abortSignal:abortSignal,
        _onProviderRequest:({ phase }) => {
          modelTelemetry[modelId].provider_request_count += 1
          if (phase === 'repair') modelTelemetry[modelId].repair_request_count += 1
        },
        _onProviderUsage:({ status, tokenCount }) => {
          if (status === 'success') modelTelemetry[modelId].successful_request_count += 1
          else modelTelemetry[modelId].failed_request_count += 1
          modelTelemetry[modelId].token_count += Math.max(0, Number(tokenCount) || 0)
        },
        _onInferencePrepared:({ systemPrompt, userPrompt, outputSchemaVersion }) => {
          if (decisionInputEvidence.has(decisionUtcMs)) return
          decisionInputEvidence.set(decisionUtcMs, {
            decision_time_utc_msc:decisionUtcMs,
            system_prompt_sha256:comparisonFingerprint(systemPrompt || ''),
            user_prompt_sha256:comparisonFingerprint(userPrompt || ''),
            output_schema_version:outputSchemaVersion || null,
          })
        },
      }
      const startedAt = Date.now()
      try {
        const signal = await maybeAiSignal(null, config, market, prompt)
        return {
          modelId,
          latencyMs: Date.now() - startedAt,
          signal: { ...signal, _inference_source: signal._inference_source || 'unknown' },
        }
      } catch (error) {
        if (abortSignal?.aborted) throw error
        return {
          modelId,
          latencyMs:Date.now() - startedAt,
          error:boundedComparisonError(error.message, 'inference_failed'),
        }
      }
    })

    const results = await Promise.all(inferenceTasks)
    for (const result of results) {
      const outcomeKline = klines[stepIdx + 1]
      const openPrice = Number(outcomeKline.open)
      const closePrice = Number(outcomeKline.close)

      if (result.error) {
        modelSignals[result.modelId].push({
          decision_time:new Date(decisionUtcMs).toISOString(), outcome_time: outcomeKline.time, time: outcomeKline.time,
          decision_time_utc_msc:decisionUtcMs, outcome_time_utc_msc:compareRateUtcMs(outcomeKline),
          signal_type: 'error', confidence: 0, next_bar_move: 0,
          latency_ms: result.latencyMs || 0, error: result.error,
        })
        continue
      }

      const signal = result.signal
      const inferenceSource = signal?._inference_source || 'unknown'
      if (inferenceSource !== 'ai') {
        modelSignals[result.modelId].push({
          decision_time:new Date(decisionUtcMs).toISOString(), outcome_time: outcomeKline.time, time: outcomeKline.time,
          decision_time_utc_msc:decisionUtcMs, outcome_time_utc_msc:compareRateUtcMs(outcomeKline),
          signal_type: 'error', confidence: 0, next_bar_move: 0, latency_ms: result.latencyMs || 0,
          error: signal?.reasoning || 'inference_failed',
        })
        continue
      }
      const direction = comparisonDirection(signal.signal_type)
      if (direction === 'unknown') {
        modelSignals[result.modelId].push({
          decision_time:new Date(decisionUtcMs).toISOString(), outcome_time: outcomeKline.time, time: outcomeKline.time,
          decision_time_utc_msc:decisionUtcMs, outcome_time_utc_msc:compareRateUtcMs(outcomeKline),
          signal_type:'error', confidence:0, next_bar_move:0, latency_ms:result.latencyMs || 0,
          error:'invalid_model_signal_type',
        })
        continue
      }
      let nextBarMove = 0
      if (direction === 'buy') nextBarMove = closePrice - openPrice
      else if (direction === 'sell') nextBarMove = openPrice - closePrice

      modelSignals[result.modelId].push({
        decision_time:new Date(decisionUtcMs).toISOString(), outcome_time: outcomeKline.time, time: outcomeKline.time,
        decision_time_utc_msc:decisionUtcMs, outcome_time_utc_msc:compareRateUtcMs(outcomeKline),
        signal_type: direction, confidence: signal.confidence || 0, next_bar_move: nextBarMove,
        latency_ms: result.latencyMs || 0,
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
      })
    }
    await onProgress({
      stage: 'evaluating',
      progress_percent: 15 + Math.round(((stepNumber + 1) / Math.max(1, steps.length)) * 80),
      completed_steps: stepNumber + 1,
      total_steps: steps.length,
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
  const hasActionableSignals = Object.values(modelSignals).some(signals =>
    signals.some(signal => signal.signal_type === 'buy' || signal.signal_type === 'sell'))
  if (hasActionableSignals) {
    await onProgress({
      stage:'backtesting',
      progress_percent:96,
      completed_steps:steps.length,
      total_steps:steps.length,
    })
    const [executionResult, symbolResult] = await Promise.allSettled([
      loadHistoryExecutionCandles(userId, symbol,
        historyExecutionWindows(modelSignals, endUtcMs, backtestOptions.max_holding_hours)),
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
    const holdCount = signals.filter(s => s.signal_type === 'hold').length
    const correctCount = signals.filter(s => s.next_bar_move > 0).length
    const incorrectCount = signals.filter(s => s.next_bar_move < 0).length
    const flatCount = signals.filter(s => ['buy', 'sell'].includes(s.signal_type) && s.next_bar_move === 0).length
    const errorCount = signals.filter(s => s.signal_type === 'error').length
    const tradeCount = buyCount + sellCount
    const successfulCount = signals.length - errorCount
    const responseSuccessRate = signals.length > 0 ? (successfulCount / signals.length) * 100 : 0
    const actionRate = successfulCount > 0 ? (tradeCount / successfulCount) * 100 : 0
    const averageConfidence = successfulCount > 0
      ? signals.filter(s => s.signal_type !== 'error').reduce((sum, s) => sum + Number(s.confidence || 0), 0) / successfulCount
      : 0
    const averageLatency = signals.length > 0
      ? signals.reduce((sum, s) => sum + Number(s.latency_ms || 0), 0) / signals.length
      : 0
    const qualityScore = wilsonLowerBound(correctCount, tradeCount) * (0.7 + 0.3 * responseSuccessRate / 100) * 100
    const accountSimulation = backtestContext.status === 'ready'
      ? simulateVirtualAccount(signals, backtestContext.execution_candles, backtestContext.instrument, runtimeBacktestOptions)
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
      status: successfulCount > 0 ? 'success' : 'error',
      error: successfulCount > 0 ? null : 'model_compare_no_valid_response',
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
        action_rate: Number(actionRate.toFixed(1)),
        response_success_rate: Number(responseSuccessRate.toFixed(1)),
        average_confidence: Number((averageConfidence * 100).toFixed(1)),
        average_latency_ms: Math.round(averageLatency),
        avg_next_bar_move: tradeCount > 0 ? Number((totalMove / tradeCount).toFixed(10)) : 0,
        buy_count: buyCount,
        sell_count: sellCount,
        hold_count: holdCount,
        error_count: errorCount,
      },
    })
  }

  const agreementByStep = steps.map((_, index) => {
    const directions = modelResults.map(result => result.signals[index]?.signal_type)
      .filter(direction => direction && direction !== 'error')
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
    : hasActionableSignals ? 'unavailable' : 'not_applicable'
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
    run_version:'history-compare-v4',
    reproducibility_level:'input_auditable_model_nondeterministic',
    strategy:strategyRuntimeSnapshot,
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
  }
  reproducibilityEvidence.evidence_sha256 = comparisonFingerprint(reproducibilityEvidence)

  return {
    status: 'success',
    results: [...modelResults, ...modelErrors],
    meta: {
      symbol, timeframe:requestedTimeframe, strategy_id: Number(strategy_id),
      kline_count: klines.length,
      evaluation_mode:evaluationMode,
      sample_size:evaluationMode === 'sampled' ? requestedSampleSize : null,
      requested_step: step == null ? null : Math.max(1, Math.min(50, Number(step) || 10)),
      step: steps.length > 1 ? Math.round((steps[steps.length - 1] - steps[0]) / (steps.length - 1)) : null,
      evaluation_count: steps.length,
      max_evaluation_count:evaluationMode === 'continuous'
        ? HISTORY_COMPARE_MAX_CONTINUOUS_STEPS
        : HISTORY_COMPARE_MAX_STEPS,
      estimated_model_calls: steps.length * validModels.length,
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
      market_source: selectedWindow.window?.marketMeta?.source || null,
      start_time: klines[0]?.time, end_time: klines[klines.length - 1]?.time,
      metric_type: 'next_closed_bar_direction',
      metric_version: 'directional-eval-v2',
      account_simulation_type:'event_driven_virtual_account',
      account_simulation_version:'account-replay-v3',
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
      strategy_timeframes: planItems.map(item => item.timeframe),
      chan_enabled: policy.useChanAnalysis,
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
       params_json, result_json, error_code, cancel_requested, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`, values)
    return
  }
  await queryRun(`UPDATE ai_model_compare_jobs SET status = ?, stage = ?, progress_percent = ?,
    completed_steps = ?, total_steps = ?, result_json = ?, error_code = ?, cancel_requested = ?,
    completed_at = CASE WHEN ? IN ('succeeded','failed','cancelled') THEN NOW() ELSE completed_at END,
    updated_at = NOW() WHERE id = ? AND user_id = ?`, [
    job.status, job.stage, job.progress_percent || 0, job.completed_steps || 0, job.total_steps || 0,
    job.result ? JSON.stringify(job.result) : null, persistedError, job.cancel_requested ? 1 : 0,
    job.status, job.id, job.user_id,
  ])
}

async function reconcileInterruptedHistoryCompareJobs(userId) {
  const rows = await queryAll(`SELECT * FROM ai_model_compare_jobs
    WHERE user_id = ? AND status IN ('queued','running','cancelling')`, [Number(userId)])
  for (const row of rows || []) {
    const stale = historyCompareJobFromRow(row)
    if (!stale || historyCompareJobs.has(stale.id)) continue
    stale.status = 'failed'
    stale.stage = 'failed'
    stale.error = 'history_compare_interrupted'
    stale.cancel_requested = false
    await persistHistoryCompareJob(stale)
  }
}

export async function startHistoryCompareJob(userId, params) {
  const user = await queryOne('SELECT role FROM users WHERE id = ?', [userId])
  if (!user || user.role !== 'admin') throw new Error('admin_only')
  const strategy = params?.strategy_id
    ? await getStrategyById(Number(params.strategy_id), userId, 'admin', { forExecution:false })
    : null
  const normalizedParams = {
    ...(params || {}),
    evaluation_mode:params?.evaluation_mode == null ? 'sampled' : params.evaluation_mode,
    timeframe:strategy ? parseStrategyPolicy(strategy).marketDataPlan.primary_timeframe : null,
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
  queueMicrotask(async () => {
    try {
      if (job.cancel_requested || job.status === 'cancelled') {
        job.status = 'cancelled'
        job.stage = 'cancelled'
        job.updated_at = new Date().toISOString()
        job.updated_at_ms = Date.now()
        try {
          await persistHistoryCompareJob(job)
        } finally {
          historyCompareJobs.delete(job.id)
        }
        return
      }
      job.status = 'running'
      job.stage = 'preparing'
      job.updated_at = new Date().toISOString()
      job.updated_at_ms = Date.now()
      await persistHistoryCompareJob(job)
      const result = await handleHistoryCompare(userId, normalizedParams, {
        shouldCancel: () => job.cancel_requested || job.abort_controller.signal.aborted,
        abortSignal:job.abort_controller.signal,
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
      if (['succeeded', 'failed', 'cancelled'].includes(job.status)) historyCompareJobs.delete(job.id)
    }
  })
  return publicHistoryCompareJob(job)
}

export async function getHistoryCompareJob(userId, jobId) {
  let job = historyCompareJobs.get(String(jobId))
  if (!job) {
    const row = await queryOne('SELECT * FROM ai_model_compare_jobs WHERE id = ? AND user_id = ?', [String(jobId), Number(userId)])
    job = historyCompareJobFromRow(row)
  }
  if (!job || job.user_id !== Number(userId)) throw new Error('history_compare_job_not_found')
  if (['queued', 'running', 'cancelling'].includes(job.status) && !historyCompareJobs.has(job.id)) {
    job.status = 'failed'
    job.stage = 'failed'
    job.error = 'history_compare_interrupted'
    await persistHistoryCompareJob(job)
  }
  return publicHistoryCompareJob(job)
}

export async function cancelHistoryCompareJob(userId, jobId) {
  const job = historyCompareJobs.get(String(jobId))
  if (!job || job.user_id !== Number(userId)) return getHistoryCompareJob(userId, jobId)
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
    completed_steps, total_steps, params_json, error_code, cancel_requested, created_at, updated_at
    FROM ai_model_compare_jobs WHERE user_id = ?
    ORDER BY created_at DESC LIMIT ?`, [Number(userId), Math.max(1, Math.min(30, Number(limit) || 10))])
  const jobs = rows.map(historyCompareJobFromRow).filter(Boolean)
  for (const job of jobs) {
    if (['queued', 'running', 'cancelling'].includes(job.status) && !historyCompareJobs.has(job.id)) {
      job.status = 'failed'
      job.stage = 'failed'
      job.error = 'history_compare_interrupted'
      await persistHistoryCompareJob(job)
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
  const result = await queryRun(`DELETE FROM ai_model_compare_jobs
    WHERE id = ? AND user_id = ? AND status IN ('succeeded','failed','cancelled')`,
  [String(jobId), Number(userId)])
  if (!Number(result?.changes || 0)) throw new Error('history_compare_job_not_found')
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
}
