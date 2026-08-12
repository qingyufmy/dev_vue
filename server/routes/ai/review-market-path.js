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
  const volume = deals.reduce((sum, deal) => sum + Number(deal.volume || 0), 0)
  return volume > 0 ? deals.reduce((sum, deal) => sum + Number(deal.price || 0) * Number(deal.volume || 0), 0) / volume : null
}

export function calculateHoldingPathMetrics({ rates = [], deals = [], direction = '', offsetMinutes = 0,
  timeframeIntervalMs = 0, signal = {} } = {}) {
  const entries = deals.filter(deal => Number(deal.entry_type) === 0 || Number(deal.entry_type) === 2)
  const exits = deals.filter(deal => [1, 2, 3].includes(Number(deal.entry_type)))
  const entryMs = Math.min(...entries.map(deal => dealUtcMs(deal, offsetMinutes)).filter(Number.isFinite))
  const exitMs = Math.max(...exits.map(deal => dealUtcMs(deal, offsetMinutes)).filter(Number.isFinite))
  const entryPrice = weightedPrice(entries)
  const exitPrice = weightedPrice(exits)
  const intervalMs = Math.max(0, Number(timeframeIntervalMs) || 0)
  const path = rates.filter(rate => {
    const openTime = Number(rate.time_utc_msc)
    return openTime <= exitMs && openTime + intervalMs > entryMs
  })
  if (!Number.isFinite(entryMs) || !Number.isFinite(exitMs) || !Number.isFinite(entryPrice) || !path.length) {
    return { status: 'partial', reason: 'holding_path_not_covered', entry_time_utc_msc: Number.isFinite(entryMs) ? entryMs : null, exit_time_utc_msc: Number.isFinite(exitMs) ? exitMs : null }
  }
  const high = Math.max(...path.map(rate => Number(rate.high)))
  const low = Math.min(...path.map(rate => Number(rate.low)))
  const isBuy = String(direction).toLowerCase().startsWith('buy')
  const favorable = isBuy ? high - entryPrice : entryPrice - low
  const adverse = isBuy ? entryPrice - low : high - entryPrice
  const touched = price => Number.isFinite(Number(price)) && (isBuy ? high >= Number(price) : low <= Number(price))
  const stopTouched = Number.isFinite(Number(signal.stop_loss_price)) && (isBuy ? low <= Number(signal.stop_loss_price) : high >= Number(signal.stop_loss_price))
  return {
    status: 'complete', entry_time_utc_msc: entryMs, exit_time_utc_msc: exitMs,
    entry_price: entryPrice, exit_price: exitPrice, bars_held: path.length, path_high: high, path_low: low,
    max_favorable_excursion: Math.max(0, favorable), max_adverse_excursion: Math.max(0, adverse),
    max_favorable_excursion_pct: entryPrice ? Math.max(0, favorable) / entryPrice * 100 : null,
    max_adverse_excursion_pct: entryPrice ? Math.max(0, adverse) / entryPrice * 100 : null,
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
          initialEntryMs - contextBars * TIMEFRAME_MS[timeframe],
          initialExitMs + TIMEFRAME_MS[timeframe], { alignToPeriodStart:false,
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
      const truncatedBeforeExit = Boolean(exitMs && allClosed.at(-1)?.time_utc_msc < exitMs - TIMEFRAME_MS[timeframe])
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
      evidence[timeframe] = {
        status: closed.length >= 20 && !truncatedBeforeEntry && !truncatedBeforeExit ? 'complete' : 'partial', candle_count: closed.length,
        source_candle_count: allClosed.length, truncated_before_entry: truncatedBeforeEntry, truncated_before_exit: truncatedBeforeExit,
        first_time_utc_msc: closed[0]?.time_utc_msc || null, last_time_utc_msc: closed.at(-1)?.time_utc_msc || null,
        candles: closed, indicators: { atr_14: market.atr_14, rsi_14: market.rsi_14, macd: market.macd },
        ...(chanPolicy ? { chan: slimChan(market.chan) } : {}),
      }
      if (timeframe === timeframes[0]) { primaryRates = closed; primaryOffset = offset; primaryTruncated = truncatedBeforeEntry || truncatedBeforeExit }
    } catch (error) {
      errors.push(`${timeframe}:${String(error?.message || error).slice(0, 80)}`)
      evidence[timeframe] = { status: 'unavailable', candle_count: 0 }
    }
  }
  const metrics = includeHoldingMetrics ? calculateHoldingPathMetrics({ rates: primaryRates, deals, direction: signal.signal_type,
    offsetMinutes: primaryOffset, timeframeIntervalMs:TIMEFRAME_MS[timeframes[0]], signal }) : null
  if (primaryTruncated && metrics?.status === 'complete') { metrics.status = 'partial'; metrics.reason = 'holding_path_truncated' }
  const metricsComplete = includeHoldingMetrics ? metrics?.status === 'complete' : true
  const complete = metricsComplete && Object.values(evidence).every(item => item.status === 'complete')
  const result = { status: complete ? 'complete' : 'partial', reason: [...errors, metrics?.reason].filter(Boolean).join(',') || null,
    primary_timeframe: timeframes[0], metrics, timeframes: evidence }
  return { ...result, hash: sha256(JSON.stringify(result)) }
}
