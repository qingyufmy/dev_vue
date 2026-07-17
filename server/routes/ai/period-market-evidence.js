import { queryAll, queryOne } from '../../db.js'
import { calculateMarketData, platformRates } from './market-data.js'
import { stripBrokerSuffix } from './utils.js'
import { sha256 } from './inference-snapshots.js'

export const REVIEW_TIMEFRAME_MS = { M1:60000, M5:300000, M15:900000, M30:1800000, H1:3600000, H4:14400000, D1:86400000 }
const MAX_REVIEW_WINDOW_CANDLES = 5000
const CHAN_LOOKBACK_BARS = 200

const parse = (value, fallback = null) => { try { return value == null ? fallback : JSON.parse(value) } catch { return fallback } }
const compactRate = rate => ({ t:Number(rate.time_utc_msc), o:Number(rate.open), h:Number(rate.high), l:Number(rate.low), c:Number(rate.close), v:Number(rate.tick_volume || 0) })

export function requiredReviewCandleCount(startUtcMs, endUtcMs, timeframe) {
  const interval = REVIEW_TIMEFRAME_MS[String(timeframe || '').toUpperCase()]
  if (!interval || !Number.isFinite(Number(startUtcMs)) || !Number.isFinite(Number(endUtcMs)) || endUtcMs <= startUtcMs) return 0
  return Math.min(MAX_REVIEW_WINDOW_CANDLES, Math.ceil((endUtcMs - startUtcMs) / interval) + CHAN_LOOKBACK_BARS + 2)
}

export function isReviewGridAligned(openTimeUtcMs, periodStartUtcMs, timeframe) {
  const interval = REVIEW_TIMEFRAME_MS[String(timeframe || '').toUpperCase()]
  const delta = Number(openTimeUtcMs) - Number(periodStartUtcMs)
  return Boolean(interval && Number.isFinite(delta) && ((delta % interval) + interval) % interval === 0)
}

function slimChan(chan) {
  if (!chan) return null
  return { status:chan.status, reliability:chan.reliability, warnings:chan.warnings || [], bi_count:chan.bi_count,
    segment_count:chan.segment_count, center_count:chan.center_count, current_segment:chan.current_segment,
    prev_segment:chan.prev_segment, current_center:chan.current_center, active_center:chan.active_center,
    price_vs_center:chan.price_vs_center, divergence:chan.divergence, recent_divergences:chan.recent_divergences,
    trend_state:chan.trend_state, entry_candidates:chan.entry_candidates }
}

function timeframePlan(strategy, sourceEvidence) {
  const plan = parse(strategy?.market_data_plan_json, {}) || {}
  const configured = Array.isArray(plan.timeframes) ? plan.timeframes.map(item => String(item?.timeframe || '').toUpperCase()) : []
  if (configured.some(item => REVIEW_TIMEFRAME_MS[item])) return [...new Set(configured.filter(item => REVIEW_TIMEFRAME_MS[item]))].slice(0, 4)
  const inferred = []
  for (const source of sourceEvidence || []) {
    const frames = source?.evidence?.post_trade?.post_trade_klines || {}
    inferred.push(...Object.keys(frames))
  }
  return [...new Set(inferred.map(item => String(item).toUpperCase()).filter(item => REVIEW_TIMEFRAME_MS[item]))].slice(0, 4)
}

async function loadReviewWindow(userId, symbol, timeframe, startUtcMs, endUtcMs) {
  const count = requiredReviewCandleCount(startUtcMs, endUtcMs, timeframe)
  const interval = REVIEW_TIMEFRAME_MS[timeframe]
  const readStored = async sourceIds => {
    const ids = [...new Set((Array.isArray(sourceIds) ? sourceIds : [sourceIds]).map(Number).filter(id => id > 0))]
    if (!ids.length) return []
    const rows = await queryAll(`SELECT source_id, open_time_utc_msc AS time_utc_msc, open_price AS open, high_price AS high,
      low_price AS low, close_price AS close, tick_volume
    FROM market_candles WHERE source_id IN (${ids.map(() => '?').join(',')}) AND standard_symbol = ? AND timeframe = ?
      AND open_time_utc_msc >= ? AND open_time_utc_msc < ? ORDER BY open_time_utc_msc LIMIT ?`, [
    ...ids, stripBrokerSuffix(symbol), timeframe, startUtcMs - CHAN_LOOKBACK_BARS * interval,
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
  const cacheComplete = periodRows[0] && Number(periodRows[0].time_utc_msc) <= startUtcMs + interval
    && Number(periodRows.at(-1).time_utc_msc) >= endUtcMs - interval * 2
  let marketMeta = existingSource ? { source:'mysql_period_cache', source_id:sourceId,
    timezone_offset_minutes:existingSource.timezone_offset_minutes, clock_status:existingSource.clock_status } : {}
  if (!cacheComplete) {
    const hydrated = await platformRates(userId, { symbol, timeframe, count, review_window:true })
    sourceId = Number(hydrated?.market_meta?.source_id)
    if (hydrated?.status === 'error' || !sourceId) throw new Error(hydrated?.error || hydrated?.message || 'period_market_source_unavailable')
    const hydratedSource = await queryOne('SELECT broker_server FROM market_data_sources WHERE id = ?', [sourceId])
    relatedSourceIds = hydratedSource?.broker_server ? (await queryAll(`SELECT mds.id FROM market_data_sources mds JOIN users u ON u.id = mds.bridge_user_id
      WHERE u.role = 'admin' AND mds.broker_server = ? ORDER BY mds.last_calibrated_at, mds.id`, [hydratedSource.broker_server])).map(row => Number(row.id)) : [sourceId]
    rows = await readStored(relatedSourceIds)
    marketMeta = hydrated.market_meta || {}
  }
  rows = rows.filter(row => isReviewGridAligned(row.time_utc_msc, startUtcMs, timeframe))
  const rates = rows.map(row => ({ ...row, time_utc_msc:Number(row.time_utc_msc), open:Number(row.open), high:Number(row.high), low:Number(row.low), close:Number(row.close), tick_volume:Number(row.tick_volume || 0) }))
  const periodRates = rates.filter(rate => rate.time_utc_msc >= startUtcMs && rate.time_utc_msc < endUtcMs)
  if (!periodRates.length) throw new Error('period_market_candles_unavailable')
  return { sourceId, interval, rates, periodRates, marketMeta }
}

export async function buildDailyPeriodMarketEvidence({ userId, strategyId, symbols = [], startUtcMs, endUtcMs, sources = [] } = {}) {
  const strategy = await queryOne('SELECT market_data_plan_json, use_chan_analysis FROM auto_prompt_types WHERE id = ?', [strategyId])
  const timeframes = timeframePlan(strategy, sources)
  const uniqueSymbols = [...new Set((symbols || []).map(stripBrokerSuffix).filter(Boolean))]
  if (!uniqueSymbols.length || !timeframes.length) return { status:'unavailable', reason:'period_market_scope_missing', symbols:{}, hash:null }
  const result = { schema_version:2, status:'complete', reason:null, generated_at:new Date().toISOString(), uses_full_period_candles:true,
    chan_enabled:Boolean(strategy?.use_chan_analysis), symbols:{} }
  const errors = []
  for (const symbol of uniqueSymbols) {
    result.symbols[symbol] = {}
    for (const timeframe of timeframes) {
      try {
        const loaded = await loadReviewWindow(userId, symbol, timeframe, startUtcMs, endUtcMs)
        const sentinel = { ...loaded.rates.at(-1), time_utc_msc:loaded.rates.at(-1).time_utc_msc + loaded.interval }
        const market = calculateMarketData(symbol, timeframe, [...loaded.rates, sentinel], {}, [], {
          computeChan:Boolean(strategy?.use_chan_analysis), chanRates:[...loaded.rates, sentinel],
          requestedChanHistoryCount:loaded.rates.length, chanDataQuality:loaded.marketMeta,
        })
        const expected = Math.ceil((endUtcMs - startUtcMs) / loaded.interval)
        const first = loaded.periodRates[0]?.time_utc_msc
        const last = loaded.periodRates.at(-1)?.time_utc_msc
        const complete = first <= startUtcMs + loaded.interval && last >= endUtcMs - loaded.interval * 2
        const highs = loaded.periodRates.map(item => item.high); const lows = loaded.periodRates.map(item => item.low)
        result.symbols[symbol][timeframe] = {
          status:complete ? 'complete' : 'partial', candle_count:loaded.periodRates.length, expected_candle_count:expected,
          first_time_utc_msc:first, last_time_utc_msc:last, full_period_candles:loaded.periodRates.map(compactRate),
          summary:{ open:loaded.periodRates[0].open, high:Math.max(...highs), low:Math.min(...lows), close:loaded.periodRates.at(-1).close,
            atr_14:market.atr_14, rsi_14:market.rsi_14, macd:market.macd, chan:slimChan(market.chan) },
        }
        if (!complete) result.status = 'partial'
      } catch (error) {
        const reason = String(error?.message || error).slice(0, 96)
        errors.push(`${symbol}:${timeframe}:${reason}`)
        result.symbols[symbol][timeframe] = { status:'unavailable', candle_count:0, reason }
        result.status = 'partial'
      }
    }
  }
  result.reason = errors.join(',') || null
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
