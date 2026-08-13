import { queryAll, queryOne } from '../../db.js'
import { calculateMarketData, platformRates } from './market-data.js'
import { stripBrokerSuffix } from './utils.js'
import { sha256 } from './inference-snapshots.js'
import { resolveFrozenChanRequirement } from './inference-snapshots.js'
import { getChanWindowPolicy, CHAN_WINDOW_POLICY_VERSION } from './chan-window-policy.js'
import { classifyContinuityGap, MARKET_SESSION_CALENDAR_VERSION } from './market-session-calendar.js'

export const REVIEW_TIMEFRAME_MS = { M1:60000, M5:300000, M15:900000, M30:1800000, H1:3600000, H4:14400000, D1:86400000 }
const MAX_REVIEW_WINDOW_CANDLES = 5000
// Ordinary indicator/context warmup. Chan history is always supplied through
// its frozen v6 window policy and never falls back to this value.
const REVIEW_CONTEXT_LOOKBACK_BARS = 200
const DAILY_MAINTENANCE_TOLERANCE_MS = 2 * 3600000

const parse = (value, fallback = null) => { try { return value == null ? fallback : JSON.parse(value) } catch { return fallback } }
const compactRate = rate => ({ t:Number(rate.time_utc_msc), o:Number(rate.open), h:Number(rate.high), l:Number(rate.low), c:Number(rate.close), v:Number(rate.tick_volume || 0) })

export function requiredReviewCandleCount(startUtcMs, endUtcMs, timeframe, options = {}) {
  const interval = REVIEW_TIMEFRAME_MS[String(timeframe || '').toUpperCase()]
  if (!interval || !Number.isFinite(Number(startUtcMs)) || !Number.isFinite(Number(endUtcMs)) || endUtcMs <= startUtcMs) return 0
  const chanHistoryTarget = Number(options.chanHistoryTarget || options.chanMaximumHistoryCount)
  const contextLookback = Number.isFinite(Number(options.reviewContextLookback))
    ? Math.max(0, Math.trunc(Number(options.reviewContextLookback))) : REVIEW_CONTEXT_LOOKBACK_BARS
  const chanLookback = options.includeChanHistory === true && Number.isFinite(chanHistoryTarget) && chanHistoryTarget > 0
    ? Math.trunc(chanHistoryTarget) : 0
  const lookback = Math.max(contextLookback, chanLookback)
  return Math.min(MAX_REVIEW_WINDOW_CANDLES, Math.ceil((endUtcMs - startUtcMs) / interval) + lookback + 2)
}

export function isReviewGridAligned(openTimeUtcMs, periodStartUtcMs, timeframe) {
  const interval = REVIEW_TIMEFRAME_MS[String(timeframe || '').toUpperCase()]
  const delta = Number(openTimeUtcMs) - Number(periodStartUtcMs)
  return Boolean(interval && Number.isFinite(delta) && ((delta % interval) + interval) % interval === 0)
}

function crossesWeekend(startUtcMs, endUtcMs) {
  const hour = 3600000
  for (let cursor = Math.floor(startUtcMs / hour) * hour; cursor <= endUtcMs; cursor += hour) {
    const day = new Date(cursor).getUTCDay()
    if (day === 0 || day === 6) return true
  }
  return false
}

export function assessReviewCandleCoverage(rates, startUtcMs, endUtcMs, timeframe, options = {}) {
  const interval = REVIEW_TIMEFRAME_MS[String(timeframe || '').toUpperCase()]
  const sorted = [...(rates || [])]
    .map(row => Number(row?.time_utc_msc))
    .filter(Number.isFinite)
    .filter(time => time >= Number(startUtcMs) && time < Number(endUtcMs))
    .sort((a, b) => a - b)
    .filter((time, index, values) => index === 0 || time !== values[index - 1])
  if (!interval || !sorted.length) return { complete:false, endpoint_complete:false, internal_gap_count:0, max_gap_ms:0,
    continuity_status:'unavailable', continuity_reason:'period_market_candles_missing', continuity_reasons:['period_market_candles_missing'] }
  const strictSessionPolicy = options.strictSessionPolicy === true
  const standardSymbol = stripBrokerSuffix(options.standardSymbol || options.symbol || '')
  const continuityReasons = new Set()
  let unknownSessionGapCount = 0
  const maybeDailyPolicyGap = (from, to) => {
    const gap = Number(to) - Number(from)
    return strictSessionPolicy && gap > Math.max(interval, 30 * 60 * 1000)
      && gap <= DAILY_MAINTENANCE_TOLERANCE_MS
  }
  const closure = (from, to) => classifyContinuityGap(from, to, timeframe, {
    intervalMs:interval, standardSymbol, strictSessionPolicy,
    timezoneOffsetMinutes:options.timezoneOffsetMinutes ?? options.timezone_offset_minutes,
    sessionTimezone:options.sessionTimezone || options.session_timezone,
    clockStatus:options.clockStatus || options.clock_status,
    policyVersion:options.policyVersion || options.marketSessionPolicyVersion || MARKET_SESSION_CALENDAR_VERSION,
  })
  const closureComplete = (from, to) => {
    const result = closure(from, to)
    if (result?.classification === 'unknown_session' || result?.known === false) {
      unknownSessionGapCount += 1
      continuityReasons.add(result.reason || 'market_session_policy_unavailable')
    } else if (!result && maybeDailyPolicyGap(from, to)) {
      continuityReasons.add('daily_session_policy_missing')
    }
    return result?.known === true
  }
  // Historical ranges are hydrated directly from MT5 before this check. In
  // strict mode only an explicitly known closure can cover an endpoint gap.
  const startTolerance = Math.max(interval, DAILY_MAINTENANCE_TOLERANCE_MS)
  const endTolerance = Math.max(interval * 2, DAILY_MAINTENANCE_TOLERANCE_MS)
  const startCovered = strictSessionPolicy
    ? sorted[0] <= Number(startUtcMs) || closureComplete(Number(startUtcMs) - interval, sorted[0])
    : sorted[0] <= Number(startUtcMs) + startTolerance || crossesWeekend(Number(startUtcMs), sorted[0])
  const endCovered = strictSessionPolicy
    ? sorted.at(-1) + interval >= Number(endUtcMs) || closureComplete(sorted.at(-1), Number(endUtcMs))
    : sorted.at(-1) >= Number(endUtcMs) - endTolerance || crossesWeekend(sorted.at(-1), Number(endUtcMs))
  const endpointComplete = startCovered && endCovered
  // 黄金、外汇每天可能存在短暂维护休市。只把超过两小时且不跨周末的缺口视为异常，
  // 避免将正常休市误判成缓存损坏，同时仍能识别桥接长时间断开造成的大段缺失。
  const toleratedGap = Math.max(interval * 3, 2 * 3600000)
  let internalGapCount = 0
  let maxGapMs = 0
  for (let index = 1; index < sorted.length; index += 1) {
    const gap = sorted[index] - sorted[index - 1]
    const knownClosure = gap > interval && closureComplete(sorted[index - 1], sorted[index])
    const tolerated = strictSessionPolicy ? knownClosure : gap <= toleratedGap || crossesWeekend(sorted[index - 1], sorted[index])
    if (gap > interval && !tolerated) {
      internalGapCount += 1
      maxGapMs = Math.max(maxGapMs, gap)
    }
  }
  const continuityStatus = continuityReasons.size
    ? (unknownSessionGapCount > 0 ? 'unknown_session' : 'policy_missing')
    : 'reliable'
  return { complete:endpointComplete && internalGapCount === 0, endpoint_complete:endpointComplete, internal_gap_count:internalGapCount,
    max_gap_ms:maxGapMs, continuity_status:continuityStatus,
    continuity_reason:[...continuityReasons][0] || null, continuity_reasons:[...continuityReasons], unknown_session_gap_count:unknownSessionGapCount }
}

function slimChan(chan) {
  if (!chan) return null
  return { ...chan, warnings:Array.isArray(chan.warnings) ? chan.warnings : [] }
}

function timeframePlan(sourceEvidence, enabledTimeframes = []) {
  const inferred = []
  for (const source of sourceEvidence || []) {
    const evidence = source?.evidence || source || {}
    const postTrade = evidence?.post_trade || {}
    const pathEvidence = postTrade?.path_evidence || evidence?.path_evidence || {}
    const frameMaps = [
      postTrade?.post_trade_klines,
      postTrade?.post_trade_structure,
      pathEvidence?.coverage,
    ]
    for (const frames of frameMaps) {
      if (frames && typeof frames === 'object' && !Array.isArray(frames)) inferred.push(...Object.keys(frames))
    }
  }
  inferred.push(...enabledTimeframes)
  return [...new Set(inferred.map(item => String(item || '').toUpperCase()).filter(item => REVIEW_TIMEFRAME_MS[item]))]
    .sort((left, right) => REVIEW_TIMEFRAME_MS[left] - REVIEW_TIMEFRAME_MS[right])
}

export async function loadPeriodMarketWindow(userId, symbol, timeframe, startUtcMs, endUtcMs, options = {}) {
  const chanHistoryTarget = Number(options.chanHistoryTarget || options.chanMaximumHistoryCount)
  const requestedChanLookback = options.includeChanHistory === true && Number.isFinite(chanHistoryTarget) && chanHistoryTarget > 0
    ? Math.trunc(chanHistoryTarget) : 0
  const historyLookback = Math.max(REVIEW_CONTEXT_LOOKBACK_BARS, requestedChanLookback)
  const count = requiredReviewCandleCount(startUtcMs, endUtcMs, timeframe, {
    chanHistoryTarget:historyLookback, includeChanHistory:options.includeChanHistory !== false,
  })
  const interval = REVIEW_TIMEFRAME_MS[timeframe]
  const readStored = async sourceIds => {
    const ids = [...new Set((Array.isArray(sourceIds) ? sourceIds : [sourceIds]).map(Number).filter(id => id > 0))]
    if (!ids.length) return []
    const rows = await queryAll(`SELECT source_id, open_time_utc_msc AS time_utc_msc, open_price AS open, high_price AS high,
      low_price AS low, close_price AS close, tick_volume, spread
    FROM market_candles WHERE source_id IN (${ids.map(() => '?').join(',')}) AND standard_symbol = ? AND timeframe = ?
      AND open_time_utc_msc >= ? AND open_time_utc_msc < ? ORDER BY open_time_utc_msc LIMIT ?`, [
    ...ids, stripBrokerSuffix(symbol), timeframe, startUtcMs - historyLookback * interval,
    endUtcMs, MAX_REVIEW_WINDOW_CANDLES * 4,
  ])
    const merged = new Map()
    for (const row of rows) merged.set(Number(row.time_utc_msc), row)
    return [...merged.values()].sort((a, b) => Number(a.time_utc_msc) - Number(b.time_utc_msc))
  }
  const existingSource = await queryOne(`SELECT mds.id, mds.broker_server, mds.timezone_offset_minutes, mds.clock_status
    FROM market_data_sources mds JOIN users u ON u.id = mds.bridge_user_id
    WHERE u.role = 'admin' AND EXISTS (SELECT 1 FROM market_candles candles
      WHERE candles.source_id = mds.id AND candles.standard_symbol = ? AND candles.timeframe = ? LIMIT 1)
    ORDER BY (mds.clock_status = 'calibrated') DESC, mds.last_calibrated_at DESC, mds.id DESC LIMIT 1`, [stripBrokerSuffix(symbol), timeframe])
  let sourceId = Number(existingSource?.id)
  let relatedSourceIds = []
  if (sourceId) relatedSourceIds = (await queryAll(`SELECT mds.id FROM market_data_sources mds JOIN users u ON u.id = mds.bridge_user_id
    WHERE u.role = 'admin' AND mds.broker_server = ? ORDER BY mds.last_calibrated_at, mds.id`, [existingSource.broker_server])).map(row => Number(row.id))
  let rows = relatedSourceIds.length ? await readStored(relatedSourceIds) : []
  let periodRows = rows.filter(row => Number(row.time_utc_msc) >= startUtcMs && Number(row.time_utc_msc) < endUtcMs)
  let marketMeta = existingSource ? { source:'mysql_period_cache', source_id:sourceId,
    timezone_offset_minutes:existingSource.timezone_offset_minutes, clock_status:existingSource.clock_status } : {}
  let coverage = assessReviewCandleCoverage(periodRows, startUtcMs, endUtcMs, timeframe, {
    ...marketMeta, strictSessionPolicy:options.strictSessionPolicy === true,
    standardSymbol:stripBrokerSuffix(symbol),
  })
  if (!coverage.complete) {
    const hydrated = await platformRates(userId, { symbol, timeframe, count, review_window:true,
      start_utc_msc:startUtcMs - historyLookback * interval, end_utc_msc:endUtcMs })
    sourceId = Number(hydrated?.market_meta?.source_id)
    if (hydrated?.status === 'error' || !sourceId) throw new Error(hydrated?.error || hydrated?.message || 'period_market_source_unavailable')
    const hydratedSource = await queryOne('SELECT broker_server FROM market_data_sources WHERE id = ?', [sourceId])
    relatedSourceIds = hydratedSource?.broker_server ? (await queryAll(`SELECT mds.id FROM market_data_sources mds JOIN users u ON u.id = mds.bridge_user_id
      WHERE u.role = 'admin' AND mds.broker_server = ? ORDER BY mds.last_calibrated_at, mds.id`, [hydratedSource.broker_server])).map(row => Number(row.id)) : [sourceId]
    rows = await readStored(relatedSourceIds)
    marketMeta = hydrated.market_meta || {}
  }
  // Daily/monthly reviews use a fixed period boundary and may require strict
  // grid alignment. Model comparison accepts arbitrary minute ranges, so its
  // already-normalized stored candles must not be aligned to the user's start
  // minute (for example 23:47), otherwise every H1/H4 candle is discarded.
  if (options.alignToPeriodStart !== false) {
    rows = rows.filter(row => isReviewGridAligned(row.time_utc_msc, startUtcMs, timeframe))
  }
  const rates = rows.map(row => ({ ...row, time_utc_msc:Number(row.time_utc_msc), open:Number(row.open), high:Number(row.high), low:Number(row.low), close:Number(row.close), tick_volume:Number(row.tick_volume || 0), spread:Number(row.spread || 0) }))
  const periodRates = rates.filter(rate => rate.time_utc_msc >= startUtcMs && rate.time_utc_msc < endUtcMs)
  if (!periodRates.length) throw new Error('period_market_candles_unavailable')
  coverage = assessReviewCandleCoverage(periodRates, startUtcMs, endUtcMs, timeframe, {
    ...marketMeta, strictSessionPolicy:options.strictSessionPolicy === true,
    standardSymbol:stripBrokerSuffix(symbol),
  })
  return { sourceId, interval, rates, periodRates, marketMeta, coverage }
}

export async function buildDailyPeriodMarketEvidence({ userId, strategyId, symbols = [], startUtcMs, endUtcMs, sources = [] } = {}) {
  const requirements = []
  for (const source of sources || []) {
    const evidence = source?.evidence || source
    const requirement = resolveFrozenChanRequirement(
      evidence?.inference_time?.snapshot || evidence?.snapshot || evidence,
      evidence,
    )
    requirements.push({ outcome_id:Number(source?.outcome_id || source?.outcomeId || 0) || null, requirement })
  }
  const enabled = requirements.filter(item => item.requirement.status === 'enabled')
  const disabled = requirements.filter(item => item.requirement.status === 'disabled')
  const unknown = requirements.filter(item => item.requirement.status === 'unknown')
  const enabledOutcomeIds = enabled.map(item => item.outcome_id).filter(Boolean)
  const disabledOutcomeIds = disabled.map(item => item.outcome_id).filter(Boolean)
  const unknownOutcomeIds = unknown.map(item => item.outcome_id).filter(Boolean)
  const unsupported = enabled.filter(item => Array.isArray(item.requirement.unsupported_timeframes)
    && item.requirement.unsupported_timeframes.length)
  const unsupportedOutcomeIds = unsupported.map(item => item.outcome_id).filter(Boolean)
  const unsupportedTimeframes = [...new Set(unsupported.flatMap(item => item.requirement.unsupported_timeframes || []))]
  const statuses = new Set(requirements.map(item => item.requirement.status))
  const chanStatus = statuses.size > 1 ? 'mixed' : statuses.values().next().value || 'unknown'
  const enabledTimeframes = [...new Set(enabled.flatMap(item => item.requirement.timeframes || []))]
  const timeframes = timeframePlan(sources, enabledTimeframes)
  const windowPolicyVersion = [...new Set(enabled.map(item => item.requirement.window_policy_version).filter(Boolean))][0]
    || CHAN_WINDOW_POLICY_VERSION
  const uniqueSymbols = [...new Set((symbols || []).map(stripBrokerSuffix).filter(Boolean))]
  const chanRequirement = {
    status:chanStatus, enabled_outcome_ids:enabledOutcomeIds, disabled_outcome_ids:disabledOutcomeIds,
    unknown_outcome_ids:unknownOutcomeIds, unsupported_outcome_ids:unsupportedOutcomeIds,
    unsupported_timeframes:unsupportedTimeframes,
    timeframes_by_outcome:Object.fromEntries(requirements.map(item => [String(item.outcome_id), {
      status:item.requirement.status, timeframes:item.requirement.timeframes || [], source:item.requirement.source,
    }])),
    timeframes:enabledTimeframes, window_policy_version:windowPolicyVersion,
  }
  if (!uniqueSymbols.length || !timeframes.length) return { status:'unavailable', reason:'period_market_scope_missing', symbols:{}, hash:null, schema_version:3, chan_requirement:chanRequirement }
  const result = { schema_version:3, coverage_policy_version:2, status:'complete', reason:null, generated_at:new Date().toISOString(), uses_full_period_candles:true,
    chan_requirement:chanRequirement, chan_enabled:chanStatus === 'enabled' || chanStatus === 'mixed', symbols:{} }
  const chanTimeframeSet = new Set(enabledTimeframes)
  const shouldComputeChan = chanStatus === 'enabled' || chanStatus === 'mixed'
  const errors = []
  for (const symbol of uniqueSymbols) {
    result.symbols[symbol] = {}
    for (const timeframe of timeframes) {
      try {
        const chanPolicy = shouldComputeChan && chanTimeframeSet.has(timeframe) ? getChanWindowPolicy(timeframe) : null
        const loaded = await loadPeriodMarketWindow(userId, symbol, timeframe, startUtcMs, endUtcMs, {
          chanHistoryTarget:chanPolicy?.target || 0,
          includeChanHistory:Boolean(chanPolicy),
          strictSessionPolicy:true,
        })
        const sentinel = { ...loaded.rates.at(-1), time_utc_msc:loaded.rates.at(-1).time_utc_msc + loaded.interval }
        const market = calculateMarketData(symbol, timeframe, [...loaded.rates, sentinel], {}, [], {
          computeChan:Boolean(chanPolicy?.supported),
          ...(chanPolicy ? {
            chanRates:[...loaded.rates, sentinel], requestedChanHistoryCount:chanPolicy.target,
            chanMaximumHistoryCount:chanPolicy.maximumHistoryCount,
            chanValidationWindowCounts:chanPolicy.validationWindowCounts,
            chanWindowPolicyVersion:chanPolicy.windowPolicyVersion,
          } : {}),
          chanDataQuality:loaded.marketMeta,
        })
        const expected = Math.ceil((endUtcMs - startUtcMs) / loaded.interval)
        const first = loaded.periodRates[0]?.time_utc_msc
        const last = loaded.periodRates.at(-1)?.time_utc_msc
        const complete = loaded.coverage.complete
        const highs = loaded.periodRates.map(item => item.high); const lows = loaded.periodRates.map(item => item.low)
        result.symbols[symbol][timeframe] = {
          status:complete ? 'complete' : 'partial', candle_count:loaded.periodRates.length, expected_candle_count:expected,
          first_time_utc_msc:first, last_time_utc_msc:last, full_period_candles:loaded.periodRates.map(compactRate),
           coverage:{ endpoint_complete:loaded.coverage.endpoint_complete, internal_gap_count:loaded.coverage.internal_gap_count,
             max_gap_ms:loaded.coverage.max_gap_ms, continuity_status:loaded.coverage.continuity_status || null,
             continuity_reason:loaded.coverage.continuity_reason || null,
             continuity_reasons:loaded.coverage.continuity_reasons || [],
             unknown_session_gap_count:Number(loaded.coverage.unknown_session_gap_count || 0) },
          summary:{ open:loaded.periodRates[0].open, high:Math.max(...highs), low:Math.min(...lows), close:loaded.periodRates.at(-1).close,
            atr_14:market.atr_14, rsi_14:market.rsi_14, macd:market.macd,
            ...(chanPolicy ? { chan:slimChan(market.chan) } : {}), },
        }
        if (!complete) {
          result.status = 'partial'
          if (loaded.coverage.internal_gap_count > 0) errors.push(`${symbol}:${timeframe}:${loaded.coverage.continuity_reason || 'period_market_internal_gap'}`)
          else errors.push(`${symbol}:${timeframe}:period_market_endpoint_incomplete`)
        }
      } catch (error) {
        const reason = String(error?.message || error).slice(0, 96)
        errors.push(`${symbol}:${timeframe}:${reason}`)
        result.symbols[symbol][timeframe] = { status:'unavailable', candle_count:0, reason }
        result.status = 'partial'
      }
    }
  }
  result.reason = errors.join(',') || null
  const chanEvidenceValues = Object.values(result.symbols).flatMap(frames => Object.values(frames || {}))
    .filter(value => value?.summary?.chan)
  result.chan_evidence_status = chanStatus === 'disabled' ? 'not_applicable'
    : unsupportedTimeframes.length ? 'unsupported'
    : chanStatus === 'unknown' ? 'unknown'
      : unknown.length ? 'partial'
      : !chanEvidenceValues.length ? 'unavailable'
        : chanEvidenceValues.every(value => value.status === 'complete'
          && value.summary?.chan?.history_sufficient !== false
          && value.summary?.chan?.closed_history_sufficient !== false
          && value.summary?.chan?.evidence_capabilities?.data_complete !== false
          && value.summary?.chan?.window_stable !== false
          && value.summary?.chan?.cache_internal_gap_unresolved !== true) ? 'complete' : 'partial'
  result.chan_evidence_reason = unsupportedTimeframes.length ? 'chan_timeframe_unsupported'
    : chanStatus === 'unknown' ? 'chan_requirement_unknown'
    : unknown.length ? 'chan_requirement_mixed_unknown'
      : result.chan_evidence_status === 'partial' ? 'chan_evidence_partial'
      : result.chan_evidence_status === 'unavailable' ? 'chan_evidence_unavailable' : null
  result.hash = sha256(JSON.stringify(result))
  return result
}

export function monthlyPeriodMarketDigest(dailyCases = []) {
  return dailyCases.map(row => {
    const evidence = parse(row?.evidence_json, {}) || {}
    const market = evidence.period_market || {}
    const symbols = {}
    for (const [symbol, frames] of Object.entries(market.symbols || {})) {
      symbols[symbol] = Object.fromEntries(Object.entries(frames || {}).map(([timeframe, value]) => [timeframe, {
        status:value.status, candle_count:value.candle_count, expected_candle_count:value.expected_candle_count,
        first_time_utc_msc:value.first_time_utc_msc, last_time_utc_msc:value.last_time_utc_msc, summary:value.summary || null,
      }]))
    }
    return { period_case_id:Number(row.id), period_key:row.period_key, status:market.status || 'unavailable', symbols }
  })
}
