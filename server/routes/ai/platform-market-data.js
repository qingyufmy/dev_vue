import { queryAll, queryOne, queryRun } from '../../db.js'
import { cacheGetJSON, cacheSetJSON } from '../../redis.js'
import { getActivePlatformBridgeUserId, getPlatformMarketClockState } from '../../bridge-ws.js'
import { mt5Bridge } from './market-data.js'
import { stripBrokerSuffix, timeframeIntervalMs } from './utils.js'

const CACHE_LIMIT = 1000
const CACHE_TTL_SECONDS = 24 * 60 * 60
const WRITE_BATCH_SIZE = 250
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const INTERNAL_GAP_REFILL_COOLDOWN_MS = 6 * 60 * 60 * 1000
const EXPECTED_LONG_CLOSURE_MS = 8 * 60 * 60 * 1000
const recentSampleAt = new Map()
const inFlightRates = new Map()
const internalGapRefillAttempts = new Map()
let lastCleanupAt = 0

const RETENTION_DAYS = {
  M1: 90,
  M5: 365,
  M15: 730,
  M30: 730,
  H1: 3650,
  H4: 3650,
  D1: 3650,
}

function normalizedUtcMs(rate, offsetMinutes) {
  const direct = Number(rate?.time_utc_msc)
  if (Number.isFinite(direct) && direct > 0) return direct
  const raw = Number(rate?.time_msc)
  if (Number.isFinite(raw) && raw > 0 && Number.isFinite(Number(offsetMinutes))) return raw - Number(offsetMinutes) * 60000
  const parsed = Date.parse(String(rate?.time || '').replace(' ', 'T') + 'Z')
  return Number.isFinite(parsed) && Number.isFinite(Number(offsetMinutes)) ? parsed - Number(offsetMinutes) * 60000 : null
}

function sourceIdentity(bridgeUserId, clock = {}) {
  const brokerServer = String(clock.broker_server || 'unknown').trim().slice(0, 150) || 'unknown'
  const accountLogin = String(clock.account_login || '0').trim().slice(0, 32) || '0'
  return {
    bridgeUserId: Number(bridgeUserId),
    brokerServer,
    accountLogin,
    sourceKey: `${brokerServer.toLowerCase()}|${accountLogin}`,
  }
}

function hasStableSourceIdentity(identity) {
  return identity.brokerServer !== 'unknown' && identity.accountLogin !== '0'
}

function cacheKey(sourceId, standardSymbol, timeframe) {
  return `market:candles:v2:${sourceId}:${String(standardSymbol).toUpperCase()}:${String(timeframe).toUpperCase()}`
}

function validRate(rate, offsetMinutes) {
  const prices = [rate?.open, rate?.high, rate?.low, rate?.close].map(Number)
  const utcMs = normalizedUtcMs(rate, offsetMinutes)
  if (!prices.every(Number.isFinite) || prices.some(value => value <= 0) || prices[1] < prices[2] || !utcMs) return null
  return {
    ...rate,
    time_utc_msc: utcMs,
    open: prices[0],
    high: prices[1],
    low: prices[2],
    close: prices[3],
    tick_volume: Number(rate?.tick_volume) || 0,
    spread: Number(rate?.spread) || 0,
  }
}

async function findSource(bridgeUserId, clock) {
  const identity = sourceIdentity(bridgeUserId, clock)
  if (!hasStableSourceIdentity(identity)) return { id: null, ...identity }
  const row = await queryOne(`SELECT id FROM market_data_sources
    WHERE bridge_user_id = ? AND source_key = ? LIMIT 1`, [identity.bridgeUserId, identity.sourceKey])
  return { id: row?.id || null, ...identity }
}

async function ensureSource(bridgeUserId, clock, sampleRate) {
  const identity = sourceIdentity(bridgeUserId, clock)
  if (!hasStableSourceIdentity(identity)) return null
  await queryRun(`INSERT INTO market_data_sources
    (bridge_user_id, broker_server, account_login, source_key, timezone_offset_minutes, clock_status, clock_residual_ms, last_calibrated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
    ON DUPLICATE KEY UPDATE broker_server=VALUES(broker_server), account_login=VALUES(account_login),
      timezone_offset_minutes=VALUES(timezone_offset_minutes), clock_status=VALUES(clock_status),
      clock_residual_ms=VALUES(clock_residual_ms), last_calibrated_at=NOW()`,
  [identity.bridgeUserId, identity.brokerServer, identity.accountLogin, identity.sourceKey,
    clock.timezone_offset_minutes, clock.clock_status, clock.clock_residual_ms])
  const source = await queryOne(`SELECT id FROM market_data_sources
    WHERE bridge_user_id = ? AND source_key = ? LIMIT 1`, [identity.bridgeUserId, identity.sourceKey])
  const now = Date.now()
  if (source && now - (recentSampleAt.get(source.id) || 0) >= 300000) {
    recentSampleAt.set(source.id, now)
    await queryRun(`INSERT INTO market_clock_samples
      (source_id, raw_tick_time_msc, normalized_utc_msc, timezone_offset_minutes, residual_ms, status)
      VALUES (?, ?, ?, ?, ?, ?)`, [source.id, sampleRate?.time_msc || null,
      normalizedUtcMs(sampleRate, clock.timezone_offset_minutes), clock.timezone_offset_minutes,
      clock.clock_residual_ms, clock.clock_status])
  }
  return source?.id || null
}

function splitRatesByClosure(rates, timeframe, offsetMinutes) {
  if (!Array.isArray(rates) || rates.length === 0) {
    return { closedRates: [], liveRates: [], lastBarClosed: false }
  }
  const normalized = rates.map(rate => validRate(rate, offsetMinutes)).filter(Boolean)
  if (normalized.length === 0) return { closedRates: [], liveRates: [], lastBarClosed: false }
  const latest = normalized.at(-1)
  const capturedAtUtcMs = Number(rates.at(-1)?.captured_at_utc_msc)
  const latestOpenUtcMs = Number(latest.time_utc_msc)
  const lastBarClosed = Number.isFinite(capturedAtUtcMs) && Number.isFinite(latestOpenUtcMs)
    ? capturedAtUtcMs >= latestOpenUtcMs + timeframeIntervalMs(timeframe)
    : false
  return {
    closedRates: lastBarClosed ? normalized : normalized.slice(0, -1),
    liveRates: lastBarClosed ? [] : normalized.slice(-1),
    lastBarClosed,
  }
}

function brokerDate(rate) {
  const match = String(rate?.time || '').match(/^(\d{4}-\d{2}-\d{2})/)
  return match?.[1] || null
}

function crossesWeekendUtc(startUtcMs, endUtcMs) {
  for (let cursor = startUtcMs; cursor <= endUtcMs; cursor += 86400000) {
    const day = new Date(cursor).getUTCDay()
    if (day === 0 || day === 6) return true
  }
  return false
}

export function inspectRateContinuity(rates, timeframe) {
  const intervalMs = timeframeIntervalMs(timeframe)
  const ordered = mergeRates([], Array.isArray(rates) ? rates : [], CACHE_LIMIT)
  const suspicious = []
  const expectedClosures = []
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1]
    const current = ordered[index]
    const previousUtcMs = Number(previous.time_utc_msc)
    const currentUtcMs = Number(current.time_utc_msc)
    const gapMs = currentUtcMs - previousUtcMs
    if (!Number.isFinite(gapMs) || gapMs <= intervalMs) continue
    const previousDate = brokerDate(previous)
    const currentDate = brokerDate(current)
    const crossesBrokerDate = previousDate && currentDate && previousDate !== currentDate
    const expectedClosure = crossesBrokerDate || gapMs >= EXPECTED_LONG_CLOSURE_MS
      || crossesWeekendUtc(previousUtcMs, currentUtcMs)
    const detail = {
      from_utc_msc: previousUtcMs,
      to_utc_msc: currentUtcMs,
      gap_ms: gapMs,
      missing_bar_count: Math.max(1, Math.round(gapMs / intervalMs) - 1),
    }
    if (expectedClosure) expectedClosures.push(detail)
    else suspicious.push(detail)
  }
  return {
    status: suspicious.length ? 'suspicious_gap' : 'ok',
    suspicious_gaps: suspicious,
    expected_closures: expectedClosures,
  }
}

function shouldAttemptInternalGapRefill(sourceId, standardSymbol, timeframe, integrity, now = Date.now()) {
  const gap = integrity?.suspicious_gaps?.[0]
  if (!sourceId || !gap) return false
  if (internalGapRefillAttempts.size > 512) {
    for (const [key, attemptedAt] of internalGapRefillAttempts) {
      if (now - attemptedAt >= INTERNAL_GAP_REFILL_COOLDOWN_MS) internalGapRefillAttempts.delete(key)
    }
  }
  const key = `${sourceId}:${standardSymbol}:${timeframe}:${gap.from_utc_msc}-${gap.to_utc_msc}`
  const previous = internalGapRefillAttempts.get(key) || 0
  if (now - previous < INTERNAL_GAP_REFILL_COOLDOWN_MS) return false
  internalGapRefillAttempts.set(key, now)
  return true
}

async function persistClosedCandles(sourceId, brokerSymbol, timeframe, closedRates) {
  if (!sourceId || !closedRates.length) return 0
  let persisted = 0
  for (let start = 0; start < closedRates.length; start += WRITE_BATCH_SIZE) {
    const batch = closedRates.slice(start, start + WRITE_BATCH_SIZE)
    const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
    const params = batch.flatMap(rate => [sourceId, brokerSymbol, stripBrokerSuffix(brokerSymbol), timeframe,
      rate.time_utc_msc, rate.time, rate.open, rate.high, rate.low, rate.close, rate.tick_volume, rate.spread])
    await queryRun(`INSERT INTO market_candles
      (source_id, broker_symbol, standard_symbol, timeframe, open_time_utc_msc, broker_time,
       open_price, high_price, low_price, close_price, tick_volume, spread)
      VALUES ${placeholders}
      ON DUPLICATE KEY UPDATE open_price=VALUES(open_price), high_price=VALUES(high_price),
       low_price=VALUES(low_price), close_price=VALUES(close_price), tick_volume=VALUES(tick_volume), spread=VALUES(spread)`, params)
    persisted += batch.length
  }
  return persisted
}

async function loadClosedCandles(sourceId, standardSymbol, timeframe, count) {
  if (!sourceId) return { rates: [], layer: 'none' }
  const key = cacheKey(sourceId, standardSymbol, timeframe)
  const hot = await cacheGetJSON(key)
  const required = Math.max(1, count - 1)
  if (Array.isArray(hot) && hot.length >= required) return { rates: hot.slice(-count), layer: 'redis' }
  const rows = await queryAll(`SELECT broker_symbol, broker_time AS time, open_time_utc_msc AS time_utc_msc,
    open_price AS open, high_price AS high, low_price AS low, close_price AS close,
    tick_volume, spread FROM market_candles
    WHERE source_id = ? AND standard_symbol = ? AND timeframe = ?
    ORDER BY open_time_utc_msc DESC LIMIT ?`, [sourceId, standardSymbol, timeframe, Math.min(CACHE_LIMIT, count)])
  const stored = rows.reverse().map(row => ({ ...row, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), tick_volume: Number(row.tick_volume), spread: Number(row.spread) }))
  const rates = mergeRates(stored, Array.isArray(hot) ? hot : [], count)
  if (rates.length) await cacheSetJSON(key, rates, CACHE_TTL_SECONDS)
  const layer = rates.length >= required ? 'mysql' : Array.isArray(hot) && hot.length ? 'redis_partial' : rates.length ? 'mysql_partial' : 'cold'
  return { rates, layer }
}

async function saveClosedCache(sourceId, standardSymbol, timeframe, rates) {
  if (!sourceId || !rates.length) return
  await cacheSetJSON(cacheKey(sourceId, standardSymbol, timeframe), rates.slice(-CACHE_LIMIT), CACHE_TTL_SECONDS)
}

function mergeRates(closed, live, count) {
  const merged = new Map()
  for (const rate of [...closed, ...live]) {
    const valid = validRate(rate, 0)
    if (!valid) continue
    const normalized = valid
    const utcMs = Number(normalized.time_utc_msc)
    const key = Number.isFinite(utcMs) ? utcMs : normalized.time
    merged.set(key, normalized)
  }
  const sortTime = rate => {
    const utcMs = Number(rate.time_utc_msc)
    if (Number.isFinite(utcMs)) return utcMs
    const parsed = Date.parse(String(rate.time || '').replace(' ', 'T') + 'Z')
    return Number.isFinite(parsed) ? parsed : 0
  }
  return [...merged.values()].sort((a, b) => sortTime(a) - sortTime(b)).slice(-count)
}

function ratesJoinAtCacheBoundary(left, right) {
  if (!left.length || !right.length) return false
  const cachedBoundary = Number(left.at(-1)?.time_utc_msc)
  if (!Number.isFinite(cachedBoundary)) return false
  return right.some(rate => Number(rate?.time_utc_msc) === cachedBoundary)
}

async function maybeCleanupMarketData() {
  const now = Date.now()
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return
  lastCleanupAt = now
  await queryRun('DELETE FROM market_clock_samples WHERE sampled_at < DATE_SUB(NOW(), INTERVAL 30 DAY) LIMIT 10000')
  for (const [timeframe, days] of Object.entries(RETENTION_DAYS)) {
    const cutoff = now - days * 86400000
    await queryRun(`DELETE FROM market_candles WHERE id IN (
      SELECT id FROM (
        SELECT candles.id FROM market_candles candles
        WHERE candles.timeframe = ? AND candles.open_time_utc_msc < ?
          AND NOT EXISTS (
            SELECT 1 FROM ai_market_benchmark_cases benchmark_case
            JOIN ai_market_benchmark_sets benchmark_set ON benchmark_set.id = benchmark_case.benchmark_set_id
            WHERE benchmark_set.status = 'active' AND BINARY benchmark_set.symbol = BINARY candles.standard_symbol
              AND candles.timeframe = 'M5'
              AND candles.open_time_utc_msc >= benchmark_case.start_time_utc_msc - 1209600000
              AND candles.open_time_utc_msc < benchmark_case.end_time_utc_msc
          )
        LIMIT 10000
      ) cleanup_batch
    )`, [timeframe, cutoff])
  }
}

async function getPlatformRatesCore(requestUserId, platformUserId, params) {
  const symbol = String(params.symbol || '').trim()
  const timeframe = String(params.timeframe || 'M30').toUpperCase()
  const countLimit = params.review_window === true ? 5000 : 1000
  const count = Math.min(countLimit, Math.max(2, Number(params.count) || 100))
  if (platformUserId) {
    const clock = getPlatformMarketClockState(platformUserId)
    const rangeStartUtcMs = Number(params.start_utc_msc)
    const rangeEndUtcMs = Number(params.end_utc_msc)
    const exactReviewRange = params.review_window === true && Number.isFinite(rangeStartUtcMs)
      && Number.isFinite(rangeEndUtcMs) && rangeStartUtcMs > 0 && rangeEndUtcMs > rangeStartUtcMs
    if (exactReviewRange) {
      const response = await mt5Bridge(platformUserId, 'rates', { symbol, timeframe, count,
        start_utc_msc:rangeStartUtcMs, end_utc_msc:rangeEndUtcMs }, { timeoutMs:30000, noFallback:true })
      if (response?.status === 'success' && Array.isArray(response.rates) && response.rates.length) {
        const effectiveClock = {
          ...clock,
          timezone_offset_minutes:response.rates.at(-1)?.timezone_offset_minutes ?? clock.timezone_offset_minutes,
          clock_status:response.rates.at(-1)?.clock_status || clock.clock_status,
          clock_residual_ms:response.rates.at(-1)?.clock_residual_ms ?? clock.clock_residual_ms,
        }
        const closureCutoffUtcMs = Math.min(rangeEndUtcMs, Date.now())
        const intervalMs = timeframeIntervalMs(timeframe)
        const closedRates = response.rates.map(rate => validRate(rate, effectiveClock.timezone_offset_minutes))
          .filter(rate => rate
            && rate.time_utc_msc >= rangeStartUtcMs
            && rate.time_utc_msc < rangeEndUtcMs
            && rate.time_utc_msc + intervalMs <= closureCutoffUtcMs)
        const sourceId = await ensureSource(platformUserId, effectiveClock, response.rates.at(-1))
        const brokerSymbol = response.symbol || symbol
        const persistedCount = await persistClosedCandles(sourceId, brokerSymbol, timeframe, closedRates)
        return { ...response, rates:closedRates, market_meta:{
          source:'platform_admin_bridge_range', source_user_id:platformUserId, source_id:sourceId,
          broker_symbol:brokerSymbol, timeframe, timezone_offset_minutes:effectiveClock.timezone_offset_minutes,
          clock_status:effectiveClock.clock_status, closed_candles_persisted:closedRates.length,
          closed_candles_written:persistedCount, cache_layer:'exact_range', live_candle_cached:false,
          last_bar_closed:true, cache_internal_gap_unresolved:false,
          range_start_utc_msc:rangeStartUtcMs, range_end_utc_msc:rangeEndUtcMs,
        } }
      }
    }
    const source = await findSource(platformUserId, clock).catch(() => ({ id: null }))
    const standardSymbol = stripBrokerSuffix(symbol)
    const structureAnchor = source.id ? await queryOne(`SELECT anchor_time_utc_msc, last_confirmed_segment_time_utc_msc
      FROM chan_structure_anchors WHERE source_id = ? AND standard_symbol = ? AND timeframe = ? LIMIT 1`,
    [source.id, standardSymbol, timeframe]).catch(() => null) : null
    const cachedResult = await loadClosedCandles(source.id, standardSymbol, timeframe, count).catch(() => ({ rates: [], layer: 'cold' }))
    const probeOnly = cachedResult.rates.length >= count - 1
    const fetchCount = probeOnly ? 3 : count + 1
    let response = await mt5Bridge(platformUserId, 'rates', { symbol, timeframe, count: fetchCount }, { timeoutMs: 15000, noFallback: true })
    if (response?.status === 'success' && Array.isArray(response.rates) && response.rates.length) {
      let rates = response.rates
      let effectiveClock = {
        ...clock,
        timezone_offset_minutes: rates.at(-1)?.timezone_offset_minutes ?? clock.timezone_offset_minutes,
        clock_status: rates.at(-1)?.clock_status || clock.clock_status,
        clock_residual_ms: rates.at(-1)?.clock_residual_ms ?? clock.clock_residual_ms,
      }
      let split = splitRatesByClosure(rates, timeframe, effectiveClock.timezone_offset_minutes)
      let closedRates = split.closedRates
      const cachedIntegrity = inspectRateContinuity(cachedResult.rates, timeframe)
      const boundaryGapDetected = probeOnly && !ratesJoinAtCacheBoundary(cachedResult.rates, closedRates)
      const internalGapRefillAttempted = probeOnly
        && shouldAttemptInternalGapRefill(source.id, standardSymbol, timeframe, cachedIntegrity)
      const windowRefillNeeded = boundaryGapDetected || internalGapRefillAttempted
      if (windowRefillNeeded) {
        const refill = await mt5Bridge(platformUserId, 'rates', { symbol, timeframe, count: count + 1 }, { timeoutMs: 15000, noFallback: true })
        if (refill?.status !== 'success' || !Array.isArray(refill.rates) || !refill.rates.length) {
          return { status: 'error', error: 'rates_gap_refill_failed', message: refill?.message || refill?.error || 'K 线缓存缺口补齐失败' }
        }
        response = refill
        rates = refill.rates
        effectiveClock = {
          ...clock,
          timezone_offset_minutes: rates.at(-1)?.timezone_offset_minutes ?? clock.timezone_offset_minutes,
          clock_status: rates.at(-1)?.clock_status || clock.clock_status,
          clock_residual_ms: rates.at(-1)?.clock_residual_ms ?? clock.clock_residual_ms,
        }
        split = splitRatesByClosure(rates, timeframe, effectiveClock.timezone_offset_minutes)
        closedRates = split.closedRates
      }
      const freshIntegrity = inspectRateContinuity(closedRates, timeframe)
      const internalGapDetected = cachedIntegrity.status === 'suspicious_gap' || freshIntegrity.status === 'suspicious_gap'
      const internalGapUnresolved = freshIntegrity.status === 'suspicious_gap'
      const sourceId = await ensureSource(platformUserId, effectiveClock, rates.at(-1))
      const brokerSymbol = response.symbol || symbol
      const resolvedStandardSymbol = stripBrokerSuffix(brokerSymbol)
      const persistedCount = await persistClosedCandles(sourceId, brokerSymbol, timeframe, closedRates)
      const stored = mergeRates(windowRefillNeeded ? [] : cachedResult.rates, closedRates, CACHE_LIMIT)
      await saveClosedCache(sourceId, resolvedStandardSymbol, timeframe, stored)
      return {
        ...response,
        rates: mergeRates(stored, split.liveRates, count),
        market_meta: {
          source: 'platform_admin_bridge', source_user_id: platformUserId,
          source_id: sourceId, broker_symbol: brokerSymbol, timeframe,
          timezone_offset_minutes: effectiveClock.timezone_offset_minutes,
          clock_status: effectiveClock.clock_status,
          closed_candles_persisted: stored.length,
          closed_candles_written: persistedCount,
          cache_layer: cachedResult.layer,
          cache_gap_refilled: windowRefillNeeded,
          cache_boundary_gap_refilled: boundaryGapDetected,
          cache_internal_gap_detected: internalGapDetected,
          cache_internal_gap_refill_attempted: internalGapRefillAttempted,
          cache_internal_gap_unresolved: internalGapUnresolved,
          cache_internal_gap_details: internalGapUnresolved ? freshIntegrity.suspicious_gaps.slice(0, 3) : [],
          last_bar_closed: split.lastBarClosed,
          live_candle_cached: false,
          chan_structure_anchor_utc_msc: Number(structureAnchor?.anchor_time_utc_msc) || null,
          chan_last_confirmed_segment_utc_msc: Number(structureAnchor?.last_confirmed_segment_time_utc_msc) || null,
        },
      }
    }
  }
  const fallback = await mt5Bridge(requestUserId, 'rates', { symbol, timeframe, count,
    ...(params.review_window === true && Number(params.start_utc_msc) > 0 && Number(params.end_utc_msc) > Number(params.start_utc_msc)
      ? { start_utc_msc:Number(params.start_utc_msc), end_utc_msc:Number(params.end_utc_msc) } : {}) },
  { timeoutMs: params.review_window === true ? 30000 : 15000, noFallback: true })
  if (fallback && typeof fallback === 'object') {
    const fallbackOffset = fallback.rates?.at(-1)?.timezone_offset_minutes ?? null
    const fallbackSplit = splitRatesByClosure(fallback.rates, timeframe, fallbackOffset)
    const fallbackIntegrity = inspectRateContinuity(fallbackSplit.closedRates, timeframe)
    fallback.rates = mergeRates(fallbackSplit.closedRates, fallbackSplit.liveRates, count)
    fallback.market_meta = {
      source: 'user_bridge_fallback', source_user_id: requestUserId, broker_symbol: fallback.symbol || symbol,
      timeframe, timezone_offset_minutes: fallbackOffset,
      clock_status: fallback.rates?.at(-1)?.clock_status || 'unknown', closed_candles_persisted: 0,
      cache_layer: 'none', live_candle_cached: false, last_bar_closed:fallbackSplit.lastBarClosed,
      cache_internal_gap_detected:fallbackIntegrity.status === 'suspicious_gap',
      cache_internal_gap_unresolved:fallbackIntegrity.status === 'suspicious_gap',
      cache_internal_gap_details:fallbackIntegrity.suspicious_gaps.slice(0, 3),
    }
  }
  return fallback
}

export async function saveChanStructureAnchor(sourceId, symbol, timeframe, structureAnchor) {
  const anchorTime = Number(structureAnchor?.recommended_time_utc_msc)
  if (!Number.isInteger(Number(sourceId)) || Number(sourceId) <= 0 || !Number.isFinite(anchorTime) || anchorTime <= 0) return false
  const lastConfirmedTime = Number(structureAnchor?.last_confirmed_segment_time_utc_msc)
  await queryRun(`INSERT INTO chan_structure_anchors
    (source_id, standard_symbol, timeframe, anchor_time_utc_msc, last_confirmed_segment_time_utc_msc)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      anchor_time_utc_msc = GREATEST(anchor_time_utc_msc, VALUES(anchor_time_utc_msc)),
      last_confirmed_segment_time_utc_msc = GREATEST(COALESCE(last_confirmed_segment_time_utc_msc, 0), COALESCE(VALUES(last_confirmed_segment_time_utc_msc), 0))`,
  [Number(sourceId), stripBrokerSuffix(symbol), String(timeframe || '').toUpperCase(), anchorTime,
    Number.isFinite(lastConfirmedTime) && lastConfirmedTime > 0 ? lastConfirmedTime : null])
  return true
}

export async function getPlatformRates(requestUserId, params = {}) {
  maybeCleanupMarketData().catch(error => console.error('[MarketData] cleanup failed:', error.message))
  const platformUserId = await getActivePlatformBridgeUserId()
  const key = buildRatesRequestKey(requestUserId, platformUserId, params)
  if (inFlightRates.has(key)) return inFlightRates.get(key)
  const request = getPlatformRatesCore(requestUserId, platformUserId, params).finally(() => inFlightRates.delete(key))
  inFlightRates.set(key, request)
  return request
}

export function buildRatesRequestKey(requestUserId, platformUserId, params = {}) {
  const reviewWindow = params.review_window === true
  const countLimit = reviewWindow ? 5000 : 1000
  const count = Math.min(countLimit, Math.max(2, Number(params.count) || 100))
  const range = reviewWindow ? `${Number(params.start_utc_msc) || 0}-${Number(params.end_utc_msc) || 0}` : 'current'
  return `${platformUserId || `user-${requestUserId}`}:${String(params.symbol || '').trim()}:${String(params.timeframe || 'M30').toUpperCase()}:${reviewWindow ? 'review' : 'live'}:${range}:${count}`
}

export async function getPlatformMarketStatus() {
  const platformUserId = await getActivePlatformBridgeUserId()
  return platformUserId ? getPlatformMarketClockState(platformUserId) : { connected: false, clock_status: 'offline' }
}
