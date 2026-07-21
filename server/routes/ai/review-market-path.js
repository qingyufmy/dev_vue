import { calculateMarketData } from './market-data.js'
import { sha256 } from './inference-snapshots.js'
import { queryAll, queryOne } from '../../db.js'
import { stripBrokerSuffix } from './utils.js'
import { loadPeriodMarketWindow } from './period-market-evidence.js'

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

async function reviewMarketOffset(symbol) {
  const row = await queryOne(`SELECT mds.timezone_offset_minutes
    FROM market_data_sources mds JOIN users u ON u.id = mds.bridge_user_id
    WHERE u.role = 'admin' AND mds.timezone_offset_minutes IS NOT NULL
      AND EXISTS (SELECT 1 FROM market_candles candles WHERE candles.source_id = mds.id
        AND candles.standard_symbol = ? LIMIT 1)
    ORDER BY mds.last_calibrated_at DESC, mds.id DESC LIMIT 1`, [stripBrokerSuffix(symbol)])
  return Number.isFinite(Number(row?.timezone_offset_minutes)) ? Number(row.timezone_offset_minutes) : 180
}

function slimChan(chan) {
  if (!chan) return null
  return {
    status: chan.status, reliability: chan.reliability, warnings: chan.warnings || [],
    bi_count: chan.bi_count, segment_count: chan.segment_count, center_count: chan.center_count,
    current_bi: chan.current_bi, current_segment: chan.current_segment, prev_segment: chan.prev_segment,
    current_center: chan.current_center, active_center: chan.active_center, price_vs_center: chan.price_vs_center,
    divergence: chan.divergence, recent_divergences: chan.recent_divergences,
    trend_state: chan.trend_state, entry_candidates: chan.entry_candidates,
  }
}

function compactRate(rate) {
  return { time_utc_msc: Number(rate.time_utc_msc), open: Number(rate.open), high: Number(rate.high), low: Number(rate.low), close: Number(rate.close), tick_volume: Number(rate.tick_volume || 0) }
}

export async function buildReviewMarketPath({ userId, symbol, signal = {}, snapshot = {}, deals = [], fetchRates = null,
  loadWindow = loadPeriodMarketWindow, timezoneOffsetMinutes = null } = {}) {
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
  const defaultOffset = Number.isFinite(Number(timezoneOffsetMinutes))
    ? Number(timezoneOffsetMinutes)
    : fetchRates ? 180 : await reviewMarketOffset(symbol).catch(() => 180)
  for (const timeframe of timeframes) {
    try {
      const initialEntryTimes = deals.filter(deal => [0, 2].includes(Number(deal.entry_type)))
        .map(deal => dealUtcMs(deal, defaultOffset)).filter(Number.isFinite)
      const initialExitTimes = deals.filter(deal => [1, 2, 3].includes(Number(deal.entry_type)))
        .map(deal => dealUtcMs(deal, defaultOffset)).filter(Number.isFinite)
      const initialEntryMs = initialEntryTimes.length ? Math.min(...initialEntryTimes) : null
      const initialExitMs = initialExitTimes.length ? Math.max(...initialExitTimes) : null
      if (!initialEntryMs || !initialExitMs) throw new Error('holding_deal_times_missing')
      let response
      let allRatesClosed = false
      if (fetchRates) {
        response = await fetchRates(userId, { symbol, timeframe, count: 1000 })
      } else {
        const contextBars = Math.max(80, Array.isArray(snapshotKlines[timeframe]) ? snapshotKlines[timeframe].length : 0)
        const loaded = await loadWindow(userId, symbol, timeframe,
          initialEntryMs - contextBars * TIMEFRAME_MS[timeframe],
          initialExitMs + TIMEFRAME_MS[timeframe], { alignToPeriodStart:false })
        response = { status:'success', rates:loaded.rates, market_meta:loaded.marketMeta || {} }
        allRatesClosed = true
      }
      if (response?.status === 'error' || !Array.isArray(response?.rates) || response.rates.length < 2) throw new Error(response?.error || 'rates_unavailable')
      const offset = Number(response.market_meta?.timezone_offset_minutes || 0)
      let allClosed = (allRatesClosed ? response.rates : response.rates.slice(0, -1))
        .filter(rate => Number.isFinite(Number(rate.time_utc_msc))).map(compactRate)
      const entryTimes = deals.filter(deal => [0, 2].includes(Number(deal.entry_type))).map(deal => dealUtcMs(deal, offset)).filter(Number.isFinite)
      const exitTimes = deals.filter(deal => [1, 2, 3].includes(Number(deal.entry_type))).map(deal => dealUtcMs(deal, offset)).filter(Number.isFinite)
      const entryMs = entryTimes.length ? Math.min(...entryTimes) : null
      const exitMs = exitTimes.length ? Math.max(...exitTimes) : null
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
      let closed = allClosed
      if (entryMs && exitMs) {
        const firstPath = allClosed.findIndex(rate => Number(rate.time_utc_msc) >= entryMs)
        const lastPath = allClosed.findLastIndex(rate => Number(rate.time_utc_msc) <= exitMs)
        if (firstPath >= 0 && lastPath >= firstPath) closed = allClosed.slice(Math.max(0, firstPath - 80), Math.min(allClosed.length, lastPath + 21))
      }
      const truncatedBeforeEntry = databasePathTruncated || Boolean(entryMs && allClosed[0]?.time_utc_msc > entryMs)
      const truncatedBeforeExit = Boolean(exitMs && allClosed.at(-1)?.time_utc_msc < exitMs - TIMEFRAME_MS[timeframe])
      const sentinel = closed.length ? { ...closed.at(-1), time_utc_msc: Number(closed.at(-1).time_utc_msc) + TIMEFRAME_MS[timeframe] } : null
      const market = calculateMarketData(symbol, timeframe, sentinel ? [...closed, sentinel] : closed, {}, [], {
        computeChan: true, chanRates: sentinel ? [...closed, sentinel] : closed, requestedChanHistoryCount: closed.length,
        chanDataQuality: response.market_meta || {},
      })
      evidence[timeframe] = {
        status: closed.length >= 20 && !truncatedBeforeEntry && !truncatedBeforeExit ? 'complete' : 'partial', candle_count: closed.length,
        source_candle_count: allClosed.length, truncated_before_entry: truncatedBeforeEntry, truncated_before_exit: truncatedBeforeExit,
        first_time_utc_msc: closed[0]?.time_utc_msc || null, last_time_utc_msc: closed.at(-1)?.time_utc_msc || null,
        candles: closed, indicators: { atr_14: market.atr_14, rsi_14: market.rsi_14, macd: market.macd }, chan: slimChan(market.chan),
      }
      if (timeframe === timeframes[0]) { primaryRates = closed; primaryOffset = offset; primaryTruncated = truncatedBeforeEntry || truncatedBeforeExit }
    } catch (error) {
      errors.push(`${timeframe}:${String(error?.message || error).slice(0, 80)}`)
      evidence[timeframe] = { status: 'unavailable', candle_count: 0 }
    }
  }
  const metrics = calculateHoldingPathMetrics({ rates: primaryRates, deals, direction: signal.signal_type,
    offsetMinutes: primaryOffset, timeframeIntervalMs:TIMEFRAME_MS[timeframes[0]], signal })
  if (primaryTruncated && metrics.status === 'complete') { metrics.status = 'partial'; metrics.reason = 'holding_path_truncated' }
  const complete = metrics.status === 'complete' && Object.values(evidence).every(item => item.status === 'complete')
  const result = { status: complete ? 'complete' : 'partial', reason: [...errors, metrics.reason].filter(Boolean).join(',') || null,
    primary_timeframe: timeframes[0], metrics, timeframes: evidence }
  return { ...result, hash: sha256(JSON.stringify(result)) }
}
