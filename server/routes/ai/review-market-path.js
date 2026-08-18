import { calculateMarketData } from './market-data.js'
import { sha256 } from './inference-snapshots.js'
import { queryAll, queryOne } from '../../db.js'
import { stripBrokerSuffix } from './utils.js'
import { loadPeriodMarketWindow } from './period-market-evidence.js'
import { resolveDefaultObserverClockBootstrap, trustedTerminalClock } from './terminal-clock.js'
import { getChanWindowPolicy } from './chan-window-policy.js'

const parse = (value, fallback = {}) => { try { return value == null ? fallback : JSON.parse(value) } catch { return fallback } }
const TIMEFRAME_MS = { M1: 60000, M5: 300000, M15: 900000, M30: 1800000, H1: 3600000, H4: 14400000, D1: 86400000 }
const MAX_REVIEW_PATH_CANDLES = 5000
const COMPLETE_PATH_CAPABILITIES = Object.freeze({ mfe_mae: true, target_touch: true, intrabar_sequence: true })
const UNOBSERVABLE_PATH_CAPABILITIES = Object.freeze({ mfe_mae: false, target_touch: false, intrabar_sequence: false })

export function expectedLatestClosedOpen(cutoffUtcMsc, timeframeIntervalMs) {
  const cutoff = Number(cutoffUtcMsc)
  const interval = Number(timeframeIntervalMs)
  if (!Number.isFinite(cutoff) || cutoff <= 0 || !Number.isFinite(interval) || interval <= 0) return null
  return Math.floor(cutoff / interval) * interval - interval
}

function dealUtcMs(deal, offsetMinutes = 0) {
  const raw = parse(deal?.raw_json, {})
  const direct = Number(raw.time_utc_msc)
  if (Number.isFinite(direct) && direct > 0) return direct
  const broker = Number(raw.time_msc)
  if (Number.isFinite(broker) && broker > 0) return broker - Number(offsetMinutes || 0) * 60000
  const parsed = Date.parse(String(deal?.deal_time || '').replace(' ', 'T') + '+08:00')
  return Number.isFinite(parsed) ? parsed : null
}

function dealsHaveCanonicalUtc(deals = []) {
  return deals.filter(deal => [0, 1, 2, 3].includes(Number(deal?.entry_type))).every(deal => {
    const direct = Number(parse(deal?.raw_json, {})?.time_utc_msc)
    return Number.isFinite(direct) && direct > 0
  })
}

function weightedPrice(deals) {
  const priced = deals.filter(deal => Number.isFinite(Number(deal?.price)) && Number(deal.price) > 0
    && Number.isFinite(Number(deal?.volume)) && Number(deal.volume) > 0)
  const volume = priced.reduce((sum, deal) => sum + Number(deal.volume), 0)
  return volume > 0 ? priced.reduce((sum, deal) => sum + Number(deal.price) * Number(deal.volume), 0) / volume : null
}

function holdingFacts(deals = [], offsetMinutes = 0) {
  const entries = deals.filter(deal => Number(deal?.entry_type) === 0 || Number(deal?.entry_type) === 2)
  const exits = deals.filter(deal => [1, 2, 3].includes(Number(deal?.entry_type)))
  const entryTimes = entries.map(deal => dealUtcMs(deal, offsetMinutes)).filter(Number.isFinite)
  const exitTimes = exits.map(deal => dealUtcMs(deal, offsetMinutes)).filter(Number.isFinite)
  const entryMs = entryTimes.length ? Math.min(...entryTimes) : null
  const exitMs = exitTimes.length ? Math.max(...exitTimes) : null
  const entryPrice = weightedPrice(entries)
  const exitPrice = weightedPrice(exits)
  const allDealsPriced = [...entries, ...exits].every(deal => Number.isFinite(Number(deal?.price))
    && Number(deal.price) > 0 && Number.isFinite(Number(deal?.volume)) && Number(deal.volume) > 0)
  const complete = entries.length > 0 && exits.length > 0
    && entryTimes.length === entries.length && exitTimes.length === exits.length && allDealsPriced
    && Number.isFinite(entryMs) && Number.isFinite(exitMs) && exitMs >= entryMs
    && Number.isFinite(entryPrice) && Number.isFinite(exitPrice)
  return { complete, entries, exits, entryMs, exitMs, entryPrice, exitPrice }
}

function emptyPathMetrics(facts, boundaryCandles = [], reason = 'holding_trade_facts_missing') {
  return {
    status: 'partial', path_metrics_status: 'incomplete', trade_facts_status: 'incomplete', reason,
    metric_precision: 'insufficient', capabilities: { ...UNOBSERVABLE_PATH_CAPABILITIES },
    boundary_candle_partial: boundaryCandles.length > 0, boundary_candle_count: boundaryCandles.length,
    entry_time_utc_msc: Number.isFinite(facts.entryMs) ? facts.entryMs : null,
    exit_time_utc_msc: Number.isFinite(facts.exitMs) ? facts.exitMs : null,
    entry_price: Number.isFinite(facts.entryPrice) ? facts.entryPrice : null,
    exit_price: Number.isFinite(facts.exitPrice) ? facts.exitPrice : null,
    holding_duration_ms: Number.isFinite(facts.entryMs) && Number.isFinite(facts.exitMs) && facts.exitMs >= facts.entryMs
      ? facts.exitMs - facts.entryMs : null,
  }
}

function unobservablePathMetrics(facts, boundaryCandles = []) {
  return {
    status: 'not_observable', path_metrics_status: 'not_observable', trade_facts_status: 'complete',
    reason: 'holding_path_intrabar_unobservable', metric_precision: 'not_observable',
    capabilities: { ...UNOBSERVABLE_PATH_CAPABILITIES },
    boundary_candle_partial: boundaryCandles.length > 0, boundary_candle_count: boundaryCandles.length,
    entry_time_utc_msc: facts.entryMs, exit_time_utc_msc: facts.exitMs,
    entry_price: facts.entryPrice, exit_price: facts.exitPrice,
    holding_duration_ms: facts.exitMs - facts.entryMs,
    bars_held: 0, path_high: null, path_low: null,
    max_favorable_excursion: null, max_adverse_excursion: null,
    max_favorable_excursion_pct: null, max_adverse_excursion_pct: null,
    take_profit_touched: null, stop_loss_touched: null,
  }
}

export function calculateHoldingPathMetrics({ rates = [], deals = [], direction = '', offsetMinutes = 0,
  timeframeIntervalMs = 0, signal = {} } = {}) {
  const facts = holdingFacts(deals, offsetMinutes)
  const intervalMs = Math.max(0, Number(timeframeIntervalMs) || 0)
  const strictPath = rates.filter(rate => {
    const openTime = Number(rate.time_utc_msc)
    return intervalMs > 0 && openTime >= facts.entryMs && openTime + intervalMs <= facts.exitMs
  })
  const boundaryCandles = rates.filter(rate => {
    const openTime = Number(rate.time_utc_msc)
    return intervalMs > 0 && openTime < facts.exitMs && openTime + intervalMs > facts.entryMs
      && !(openTime >= facts.entryMs && openTime + intervalMs <= facts.exitMs)
  })
  if (!facts.complete) return emptyPathMetrics(facts, boundaryCandles)
  if (!intervalMs) return emptyPathMetrics(facts, boundaryCandles, 'holding_timeframe_missing')
  if (!strictPath.length) return unobservablePathMetrics(facts, boundaryCandles)
  if (strictPath.some(rate => !Number.isFinite(Number(rate.high)) || !Number.isFinite(Number(rate.low)))) {
    return emptyPathMetrics(facts, boundaryCandles, 'holding_path_candles_invalid')
  }
  const knownPrices = [facts.entryPrice, facts.exitPrice].filter(Number.isFinite)
  const high = Math.max(...knownPrices, ...strictPath.map(rate => Number(rate.high)))
  const low = Math.min(...knownPrices, ...strictPath.map(rate => Number(rate.low)))
  const isBuy = String(direction).toLowerCase().startsWith('buy')
  const favorable = isBuy ? high - facts.entryPrice : facts.entryPrice - low
  const adverse = isBuy ? facts.entryPrice - low : high - facts.entryPrice
  const touched = price => Number.isFinite(Number(price)) && (isBuy ? high >= Number(price) : low <= Number(price))
  const stopTouched = Number.isFinite(Number(signal.stop_loss_price)) && (isBuy ? low <= Number(signal.stop_loss_price) : high >= Number(signal.stop_loss_price))
  return {
    status: 'complete', path_metrics_status: 'complete', trade_facts_status: 'complete',
    metric_precision:'bar_bounded', capabilities: { ...COMPLETE_PATH_CAPABILITIES }, boundary_candle_partial:boundaryCandles.length > 0,
    boundary_candle_count:boundaryCandles.length, entry_time_utc_msc: facts.entryMs, exit_time_utc_msc: facts.exitMs,
    entry_price: facts.entryPrice, exit_price: facts.exitPrice, holding_duration_ms:facts.exitMs - facts.entryMs,
    bars_held: strictPath.length, path_high: high, path_low: low,
    max_favorable_excursion: Math.max(0, favorable), max_adverse_excursion: Math.max(0, adverse),
    max_favorable_excursion_pct: facts.entryPrice ? Math.max(0, favorable) / facts.entryPrice * 100 : null,
    max_adverse_excursion_pct: facts.entryPrice ? Math.max(0, adverse) / facts.entryPrice * 100 : null,
    take_profit_touched: [signal.take_profit_1_price, signal.take_profit_2_price, signal.take_profit_3_price].map(touched),
    stop_loss_touched: stopTouched,
  }
}

async function reviewMarketOffset(userId, tradingAccountId) {
  const row = await queryOne(`SELECT accounts.broker_server,
      mds.timezone_offset_minutes, mds.clock_status
    FROM trading_accounts accounts
    LEFT JOIN market_data_sources mds ON mds.bridge_user_id = accounts.user_id
      AND UPPER(COALESCE(mds.broker_server, '')) = UPPER(accounts.broker_server)
      AND CAST(COALESCE(mds.account_login, 0) AS CHAR) = CAST(accounts.login_account AS CHAR)
    WHERE accounts.user_id = ? AND accounts.id = ?
    ORDER BY mds.last_calibrated_at DESC, mds.id DESC LIMIT 1`, [Number(userId), Number(tradingAccountId)])
  const clock = await resolveDefaultObserverClockBootstrap(row || {})
  return trustedTerminalClock(clock) ? Number(clock.timezone_offset_minutes) : null
}

function slimChan(chan) {
  if (!chan) return null
  return { ...chan, warnings:Array.isArray(chan.warnings) ? chan.warnings : [] }
}

function compactRate(rate) {
  return { time_utc_msc: Number(rate.time_utc_msc), open: Number(rate.open), high: Number(rate.high), low: Number(rate.low), close: Number(rate.close), tick_volume: Number(rate.tick_volume || 0) }
}

function crossesWeekend(startUtcMs, endUtcMs) {
  const hour = 3600000
  for (let cursor = Math.floor(Number(startUtcMs) / hour) * hour; cursor <= Number(endUtcMs); cursor += hour) {
    const day = new Date(cursor).getUTCDay()
    if (day === 0 || day === 6) return true
  }
  return false
}

function countHoldingCandleGaps(rates = [], entryMs, exitMs, intervalMs) {
  if (!Number.isFinite(entryMs) || !Number.isFinite(exitMs) || !intervalMs) return 0
  const firstOpen = Math.floor(entryMs / intervalMs) * intervalMs
  const lastOpen = exitMs % intervalMs === 0
    ? exitMs - intervalMs : Math.floor(exitMs / intervalMs) * intervalMs
  const pathRates = rates.filter(rate => {
    const openTime = Number(rate.time_utc_msc)
    return openTime >= firstOpen && openTime <= lastOpen
  }).sort((left, right) => Number(left.time_utc_msc) - Number(right.time_utc_msc))
  const pathOpens = new Set(pathRates.map(rate => Number(rate.time_utc_msc)))
  let gaps = firstOpen === lastOpen
    ? (pathOpens.has(firstOpen) ? 0 : 1)
    : Number(!pathOpens.has(firstOpen)) + Number(!pathOpens.has(lastOpen))
  for (let index = 1; index < pathRates.length; index += 1) {
    const from = Number(pathRates[index - 1].time_utc_msc)
    const to = Number(pathRates[index].time_utc_msc)
    if (to - from > intervalMs && !crossesWeekend(from, to)) gaps += 1
  }
  return gaps
}

function responseCoverageGapCount(marketMeta = {}) {
  const coverage = marketMeta.coverage && typeof marketMeta.coverage === 'object' ? marketMeta.coverage : {}
  const values = [marketMeta.internal_gap_count, marketMeta.internalGapCount, coverage.internal_gap_count,
    coverage.internalGapCount].map(Number).filter(Number.isFinite)
  const explicit = values.length ? Math.max(...values) : 0
  const status = String(marketMeta.continuity_status || coverage.continuity_status || '').toLowerCase()
  const verifiedSourceRange = ['verified_source_gap', 'verified_source_range'].includes(status)
  const detected = marketMeta.cache_internal_gap_detected === true || coverage.cache_internal_gap_detected === true
  const unresolved = marketMeta.cache_internal_gap_unresolved === true
    || marketMeta.coverage_complete === false || coverage.complete === false
    || (detected && !verifiedSourceRange)
  return Math.max(explicit, unresolved ? 1 : 0,
    ['suspicious_gap', 'unknown_session', 'unavailable'].includes(status) ? 1 : 0)
}

function hasResponseContinuityAssessment(marketMeta = {}) {
  const coverage = marketMeta.coverage && typeof marketMeta.coverage === 'object' ? marketMeta.coverage : {}
  return Boolean(String(marketMeta.continuity_status || coverage.continuity_status || '').trim())
    || [marketMeta.internal_gap_count, marketMeta.internalGapCount, coverage.internal_gap_count,
      coverage.internalGapCount].some(value => value !== null && value !== undefined && value !== '')
    || Array.isArray(marketMeta.expected_closures) || Array.isArray(coverage.expected_closures)
}

export async function buildReviewMarketPath({ userId, tradingAccountId, symbol, signal = {}, snapshot = {}, deals = [], fetchRates = null,
  loadWindow = loadPeriodMarketWindow, timezoneOffsetMinutes = null, asOfUtcMsc = null, includeHoldingMetrics = true,
  chanRequirement = undefined } = {}) {
  const snapshotKlines = snapshot?.klines && typeof snapshot.klines === 'object' ? snapshot.klines : {}
  const timeframes = [...new Set([signal.timeframe, ...Object.keys(snapshotKlines)]
    .map(value => String(value || '').toUpperCase()).filter(value => TIMEFRAME_MS[value]))]
    .sort((left, right) => TIMEFRAME_MS[left] - TIMEFRAME_MS[right]).slice(0, 4)
  if (!symbol || !timeframes.length) return { status: 'partial', reason: 'review_timeframes_missing', timeframes: {}, metrics: null }
  const evidence = {}
  let primaryRates = []
  let primaryOffset = 0
  let primaryTruncated = false
  let primaryMarketGapCount = 0
  const errors = []
  // Chan is opt-in only.  An omitted or malformed requirement is unresolved;
  // historical callers must not silently inherit the current timeframe plan.
  const effectiveChanRequirement = chanRequirement && typeof chanRequirement === 'object'
    ? chanRequirement
    : { status:'unknown', source:'unresolved', timeframes:[] }
  const chanEnabled = effectiveChanRequirement.status === 'enabled'
  const chanTimeframeSet = new Set((effectiveChanRequirement.timeframes || []).map(item => String(item).toUpperCase()))
  const hasRequestedOffset = timezoneOffsetMinutes !== null && timezoneOffsetMinutes !== undefined
    && timezoneOffsetMinutes !== '' && Number.isInteger(Number(timezoneOffsetMinutes))
  const defaultOffset = hasRequestedOffset
    ? Number(timezoneOffsetMinutes)
    : dealsHaveCanonicalUtc(deals) ? 0 : await reviewMarketOffset(userId, tradingAccountId).catch(() => null)
  if (!Number.isInteger(defaultOffset)) {
    return { status:'partial', reason:'terminal_clock_unverified', timeframes:{}, metrics:null }
  }
  for (const timeframe of timeframes) {
    try {
      const initialEntryTimes = deals.filter(deal => [0, 2].includes(Number(deal.entry_type)))
        .map(deal => dealUtcMs(deal, defaultOffset)).filter(Number.isFinite)
      const initialExitTimes = deals.filter(deal => [1, 2, 3].includes(Number(deal.entry_type)))
        .map(deal => dealUtcMs(deal, defaultOffset)).filter(Number.isFinite)
      const initialEntryMs = initialEntryTimes.length ? Math.min(...initialEntryTimes) : null
      const requestedCutoff = Number(asOfUtcMsc)
      const initialExitMs = Number.isFinite(requestedCutoff) && requestedCutoff > 0
        ? requestedCutoff : (initialExitTimes.length ? Math.max(...initialExitTimes) : null)
      if (!initialEntryMs || !initialExitMs) throw new Error('holding_deal_times_missing')
      const timeframeMs = TIMEFRAME_MS[timeframe]
      const alignedEntryMs = Math.floor(initialEntryMs / timeframeMs) * timeframeMs
      const alignedExitMs = Math.ceil(initialExitMs / timeframeMs) * timeframeMs
      let response
      let allRatesClosed = false
      const chanPolicy = chanEnabled && chanTimeframeSet.has(timeframe) ? getChanWindowPolicy(timeframe) : null
      if (fetchRates) {
        response = await fetchRates(userId, { symbol, timeframe, count: chanPolicy?.target || 1000,
          ...(chanPolicy ? { requestedChanHistoryCount:chanPolicy.target, chanMaximumHistoryCount:chanPolicy.maximumHistoryCount,
            chanValidationWindowCounts:chanPolicy.validationWindowCounts, chanWindowPolicyVersion:chanPolicy.windowPolicyVersion } : {}) })
      } else {
        const contextBars = chanPolicy?.target || Math.max(80, Array.isArray(snapshotKlines[timeframe]) ? snapshotKlines[timeframe].length : 0)
        const loaded = await loadWindow(userId, symbol, timeframe,
          alignedEntryMs - contextBars * timeframeMs,
          alignedExitMs + timeframeMs, { alignToPeriodStart:false,
            chanHistoryTarget:chanPolicy?.target || 0, chanMaximumHistoryCount:chanPolicy?.maximumHistoryCount || 0,
            includeChanHistory:Boolean(chanPolicy), strictSessionPolicy:true, standardSymbol:stripBrokerSuffix(symbol) })
        response = { status:'success', rates:loaded.rates, market_meta:loaded.marketMeta || {} }
        allRatesClosed = true
      }
      if (response?.status === 'error' || !Array.isArray(response?.rates) || response.rates.length < 2) throw new Error(response?.error || 'rates_unavailable')
      const responseOffset = response.market_meta?.timezone_offset_minutes
      const offset = responseOffset == null || responseOffset === ''
        ? defaultOffset : Number(responseOffset)
      let allClosed = (allRatesClosed ? response.rates : response.rates.slice(0, -1))
        .filter(rate => Number.isFinite(Number(rate.time_utc_msc))).map(compactRate)
        .sort((left, right) => left.time_utc_msc - right.time_utc_msc)
      let chanHistory = allClosed.slice()
      const entryTimes = deals.filter(deal => [0, 2].includes(Number(deal.entry_type))).map(deal => dealUtcMs(deal, offset)).filter(Number.isFinite)
      const exitTimes = deals.filter(deal => [1, 2, 3].includes(Number(deal.entry_type))).map(deal => dealUtcMs(deal, offset)).filter(Number.isFinite)
      const entryMs = entryTimes.length ? Math.min(...entryTimes) : null
      const exitMs = Number.isFinite(requestedCutoff) && requestedCutoff > 0
        ? requestedCutoff : (exitTimes.length ? Math.max(...exitTimes) : null)
      const sourceId = Number(response.market_meta?.source_id)
      let databasePathTruncated = false
      if (sourceId > 0 && entryMs && exitMs) {
        const stored = await queryAll(`SELECT open_time_utc_msc AS time_utc_msc, open_price AS open,
          high_price AS high, low_price AS low, close_price AS close, tick_volume
          FROM market_candles WHERE source_id = ? AND standard_symbol = ? AND timeframe = ?
            AND open_time_utc_msc BETWEEN ? AND ? ORDER BY open_time_utc_msc LIMIT ?`, [
          sourceId, stripBrokerSuffix(symbol), timeframe, entryMs - 80 * TIMEFRAME_MS[timeframe],
          exitMs + 20 * TIMEFRAME_MS[timeframe], MAX_REVIEW_PATH_CANDLES + 1,
        ])
        if (stored.length) {
          databasePathTruncated = stored.length > MAX_REVIEW_PATH_CANDLES
          allClosed = stored.slice(0, MAX_REVIEW_PATH_CANDLES).map(compactRate)
        }
      }
      if (Number.isFinite(requestedCutoff) && requestedCutoff > 0) {
        allClosed = allClosed.filter(rate => Number(rate.time_utc_msc) + TIMEFRAME_MS[timeframe] <= requestedCutoff)
        chanHistory = chanHistory.filter(rate => Number(rate.time_utc_msc) + TIMEFRAME_MS[timeframe] <= requestedCutoff)
      }
      let closed = allClosed
      if (entryMs && exitMs) {
        const firstPath = allClosed.findIndex(rate => Number(rate.time_utc_msc) >= entryMs)
        const lastPath = allClosed.findLastIndex(rate => Number(rate.time_utc_msc) <= exitMs)
        if (firstPath >= 0 && lastPath >= firstPath) closed = allClosed.slice(Math.max(0, firstPath - 80), Math.min(allClosed.length, lastPath + 21))
      }
      const truncatedBeforeEntry = databasePathTruncated || Boolean(entryMs && allClosed[0]?.time_utc_msc > entryMs)
      const expectedLastClosedOpen = expectedLatestClosedOpen(exitMs, TIMEFRAME_MS[timeframe])
      const truncatedBeforeExit = Boolean(expectedLastClosedOpen != null
        && (!allClosed.length || Number(allClosed.at(-1)?.time_utc_msc) < expectedLastClosedOpen))
      const continuityAssessed = hasResponseContinuityAssessment(response.market_meta || {})
      const marketGapCount = Math.max(responseCoverageGapCount(response.market_meta || {}),
        includeHoldingMetrics && !continuityAssessed
          ? countHoldingCandleGaps(allClosed, entryMs, exitMs, TIMEFRAME_MS[timeframe]) : 0)
      const sentinel = closed.length ? { ...closed.at(-1), time_utc_msc: Number(closed.at(-1).time_utc_msc) + TIMEFRAME_MS[timeframe] } : null
      const chanRates = chanPolicy ? (chanHistory.length ? chanHistory : allClosed) : []
      const market = calculateMarketData(symbol, timeframe, sentinel ? [...closed, sentinel] : closed, {}, [], {
        computeChan: Boolean(chanPolicy?.supported),
        ...(chanPolicy ? { chanRates, requestedChanHistoryCount:chanPolicy.target,
          chanMaximumHistoryCount:chanPolicy.maximumHistoryCount,
          chanValidationWindowCounts:chanPolicy.validationWindowCounts,
          chanWindowPolicyVersion:chanPolicy.windowPolicyVersion } : {}),
        chanDataQuality: response.market_meta || {},
      })
      const coverageReasons = [
        ...(closed.length < 20 ? ['candles_insufficient'] : []),
        ...(truncatedBeforeEntry ? ['truncated_before_entry'] : []),
        ...(truncatedBeforeExit ? ['truncated_before_exit'] : []),
        ...(marketGapCount > 0 ? ['market_internal_gap'] : []),
      ]
      evidence[timeframe] = {
        status: closed.length >= 20 && !truncatedBeforeEntry && !truncatedBeforeExit && marketGapCount === 0 ? 'complete' : 'partial', candle_count: closed.length,
        source_candle_count: allClosed.length, truncated_before_entry: truncatedBeforeEntry, truncated_before_exit: truncatedBeforeExit,
        internal_gap_count: marketGapCount,
        expected_last_closed_open_utc_msc:expectedLastClosedOpen,
        coverage_reason:coverageReasons.join(',') || null,
        first_time_utc_msc: closed[0]?.time_utc_msc || null, last_time_utc_msc: closed.at(-1)?.time_utc_msc || null,
        candles: closed, indicators: { atr_14: market.atr_14, rsi_14: market.rsi_14, macd: market.macd },
        ...(chanPolicy ? { chan: slimChan(market.chan) } : {}),
      }
      if (coverageReasons.length) errors.push(`${timeframe}:${coverageReasons.join('+')}`)
      if (timeframe === timeframes[0]) {
        primaryRates = closed; primaryOffset = offset
        primaryTruncated = truncatedBeforeEntry || truncatedBeforeExit || marketGapCount > 0
        primaryMarketGapCount = marketGapCount
      }
    } catch (error) {
      errors.push(`${timeframe}:${String(error?.message || error).slice(0, 80)}`)
      evidence[timeframe] = { status: 'unavailable', candle_count: 0 }
    }
  }
  const metrics = includeHoldingMetrics ? calculateHoldingPathMetrics({ rates: primaryRates, deals, direction: signal.signal_type,
    offsetMinutes: primaryOffset, timeframeIntervalMs:TIMEFRAME_MS[timeframes[0]], signal }) : null
  if (primaryTruncated && metrics && ['complete', 'not_observable'].includes(metrics.status)) {
    metrics.status = 'partial'; metrics.path_metrics_status = 'incomplete'
    metrics.reason = primaryMarketGapCount > 0 ? 'holding_path_market_gap' : 'holding_path_truncated'
    metrics.metric_precision = 'insufficient'
    metrics.bars_held = null; metrics.path_high = null; metrics.path_low = null
    metrics.max_favorable_excursion = null; metrics.max_adverse_excursion = null
    metrics.max_favorable_excursion_pct = null; metrics.max_adverse_excursion_pct = null
    metrics.take_profit_touched = null; metrics.stop_loss_touched = null
    metrics.capabilities = { ...UNOBSERVABLE_PATH_CAPABILITIES }
  }
  const facts = holdingFacts(deals, primaryOffset)
  const tradeFactsStatus = includeHoldingMetrics ? (metrics?.trade_facts_status || (facts.complete ? 'complete' : 'incomplete'))
    : (facts.complete ? 'complete' : 'incomplete')
  const marketCoverageStatus = Object.values(evidence).some(item => item.status === 'unavailable')
    ? 'unavailable' : Object.values(evidence).every(item => item.status === 'complete') ? 'complete' : 'partial'
  const pathMetricsStatus = includeHoldingMetrics ? (metrics?.path_metrics_status || 'incomplete') : 'not_evaluated'
  const complete = tradeFactsStatus === 'complete' && marketCoverageStatus === 'complete'
  const result = { status: complete ? 'complete' : 'partial', trade_facts_status: tradeFactsStatus,
    market_coverage_status: marketCoverageStatus, path_metrics_status: pathMetricsStatus,
    capabilities: metrics?.capabilities || null,
    reason: [...errors, metrics?.reason].filter(Boolean).join(',') || null,
    primary_timeframe: timeframes[0], metrics, timeframes: evidence }
  return { ...result, hash: sha256(JSON.stringify(result)) }
}
