import { queryAll, queryOne, queryRun } from '../../db.js'
import { cacheGetJSON, cacheSetJSON } from '../../redis.js'
import { getActivePlatformBridgeUserId, getBridgeDataRoute, getPlatformMarketClockState } from '../../bridge-ws.js'
import { mt5Bridge } from './market-data.js'
import { CHAN_ALGORITHM_VERSION, stripBrokerSuffix, timeframeIntervalMs } from './utils.js'
import { getDefaultObserverSource, observerSourceSupportsSymbol } from './observer-channels.js'

const CACHE_LIMIT = 2000
const CACHE_TTL_SECONDS = 24 * 60 * 60
const WRITE_BATCH_SIZE = 250
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const INTERNAL_GAP_REFILL_COOLDOWN_MS = 6 * 60 * 60 * 1000
const MAX_EXPECTED_DAILY_CLOSURE_MS = 4 * 60 * 60 * 1000
const FUTURE_RATE_TOLERANCE_MS = 2 * 60 * 1000
const recentSampleAt = new Map()
const inFlightRates = new Map()
const internalGapRefillAttempts = new Map()
const closedCacheWrites = new Map()
let lastCleanupAt = 0

function validTimezoneOffsetMinutes(value) {
  if (value === null || value === undefined || value === '') return null
  const offset = Number(value)
  return Number.isInteger(offset) && offset >= -14 * 60 && offset <= 14 * 60 && offset % 15 === 0
    ? offset : null
}

function validClockSampleAgeMs(value) {
  const age = Number(value)
  return Number.isFinite(age) && age >= 0 ? Math.trunc(age) : null
}

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
  const offset = validTimezoneOffsetMinutes(offsetMinutes)
  if (Number.isFinite(raw) && raw > 0 && offset != null) return raw - offset * 60000
  const parsed = Date.parse(String(rate?.time || '').replace(' ', 'T') + 'Z')
  return Number.isFinite(parsed) && offset != null ? parsed - offset * 60000 : null
}

function normalizedBrokerTime(rate, offsetMinutes, utcMs) {
  const direct = String(rate?.time || '').trim()
  if (direct) return direct.slice(0, 32)
  const serverMs = Number(rate?.time_server_msc)
  const offset = validTimezoneOffsetMinutes(offsetMinutes)
  const derivedMs = Number.isFinite(serverMs) && serverMs > 0
    ? serverMs
    : offset != null
      ? utcMs + offset * 60000
      : utcMs
  if (!Number.isFinite(derivedMs) || derivedMs <= 0) return null
  const iso = new Date(derivedMs).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`
}

function sourceIdentity(bridgeUserId, clock = {}) {
  const rawPlatform = String(clock.platform || '').trim().toLowerCase()
  const platform = rawPlatform === 'mt4' || rawPlatform === 'mt5' ? rawPlatform : 'unknown'
  const brokerServer = String(clock.broker_server || 'unknown').trim().slice(0, 150) || 'unknown'
  const accountLogin = String(clock.account_login || '0').trim().slice(0, 32) || '0'
  const timezoneOffsetMinutes = validTimezoneOffsetMinutes(clock.timezone_offset_minutes)
  return {
    bridgeUserId: Number(bridgeUserId),
    platform,
    brokerServer,
    accountLogin,
    timezoneOffsetMinutes,
    sourceKey: `${platform}|${brokerServer.toLowerCase()}|${accountLogin}`
      + (platform === 'mt4' ? `|offset:${timezoneOffsetMinutes ?? 'unknown'}` : ''),
  }
}

function hasStableSourceIdentity(identity) {
  return identity.platform !== 'unknown' && identity.brokerServer !== 'unknown' && identity.accountLogin !== '0'
    && (identity.platform !== 'mt4' || identity.timezoneOffsetMinutes != null)
}

function cacheKey(sourceId, standardSymbol, timeframe) {
  return `market:candles:v2:${sourceId}:${String(standardSymbol).toUpperCase()}:${String(timeframe).toUpperCase()}`
}

function validRate(rate, offsetMinutes) {
  const prices = [rate?.open, rate?.high, rate?.low, rate?.close].map(Number)
  const utcMs = normalizedUtcMs(rate, offsetMinutes)
  const brokerTime = normalizedBrokerTime(rate, offsetMinutes, utcMs)
  if (!prices.every(Number.isFinite) || prices.some(value => value <= 0) || prices[1] < prices[2]
    || !utcMs || utcMs > Date.now() + FUTURE_RATE_TOLERANCE_MS || !brokerTime) return null
  return {
    ...rate,
    time: brokerTime,
    time_utc_msc: utcMs,
    open: prices[0],
    high: prices[1],
    low: prices[2],
    close: prices[3],
    tick_volume: Number(rate?.tick_volume) || 0,
    spread: Number(rate?.spread) || 0,
  }
}

function effectiveResponseClock(clock, response, rates) {
  const sample = Array.isArray(rates) ? rates.at(-1) : null
  const rawPlatform = String(response?.platform || response?.source || sample?.platform || sample?.source || clock.platform || '').trim().toLowerCase()
  return {
    ...clock,
    platform:rawPlatform === 'mt4' || rawPlatform === 'mt5' ? rawPlatform : clock.platform,
    timezone_offset_minutes:response?.timezone_offset_minutes
      ?? sample?.timezone_offset_minutes ?? clock.timezone_offset_minutes,
    clock_status:response?.clock_status || sample?.clock_status || clock.clock_status,
    clock_residual_ms:response?.clock_residual_ms
      ?? sample?.clock_residual_ms ?? clock.clock_residual_ms,
    clock_sample_age_ms:validClockSampleAgeMs(response?.clock_sample_age_ms
      ?? sample?.clock_sample_age_ms ?? clock.clock_sample_age_ms),
  }
}

async function findSource(bridgeUserId, clock) {
  const identity = sourceIdentity(bridgeUserId, clock)
  if (!hasStableSourceIdentity(identity)) return { id: null, ...identity }
  const row = await queryOne(`SELECT id FROM market_data_sources
    WHERE bridge_user_id = ? AND source_key = ? LIMIT 1`, [identity.bridgeUserId, identity.sourceKey])
  return { id: row?.id || null, ...identity }
}

async function loadChanStructureAnchor(sourceId, standardSymbol, timeframe) {
  if (!Number.isInteger(Number(sourceId)) || Number(sourceId) <= 0) return null
  return queryOne(`SELECT anchor_time_utc_msc, last_confirmed_segment_time_utc_msc,
      bootstrap_core_stable_id, bootstrap_entry_segment_stable_id, bootstrap_observation_time_utc_msc
    FROM chan_structure_anchors
    WHERE source_id = ? AND standard_symbol = ? AND timeframe = ? AND algorithm_version = ? LIMIT 1`,
  [Number(sourceId), standardSymbol, timeframe, CHAN_ALGORITHM_VERSION]).catch(() => null)
}

async function ensureSource(bridgeUserId, clock, sampleRate) {
  const identity = sourceIdentity(bridgeUserId, clock)
  if (!hasStableSourceIdentity(identity)) return null
  const observerBootstrap = String(clock?.clock_status || '').trim().toLowerCase() === 'observer_bootstrap'
    || String(clock?.clock_source || '').trim().toLowerCase() === 'default_observer_source'
  if (observerBootstrap) {
    // The inherited offset may normalize this request, but it is not proof that
    // the target terminal calibrated its own clock. Keep target clock evidence empty.
    await queryRun(`INSERT INTO market_data_sources
      (bridge_user_id, broker_server, account_login, source_key, timezone_offset_minutes, clock_status, clock_residual_ms, last_calibrated_at)
      VALUES (?, ?, ?, ?, NULL, 'unknown', NULL, NULL)
      ON DUPLICATE KEY UPDATE broker_server=VALUES(broker_server), account_login=VALUES(account_login)`,
    [identity.bridgeUserId, identity.brokerServer, identity.accountLogin, identity.sourceKey])
  } else {
    await queryRun(`INSERT INTO market_data_sources
      (bridge_user_id, broker_server, account_login, source_key, timezone_offset_minutes, clock_status, clock_residual_ms, last_calibrated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE broker_server=VALUES(broker_server), account_login=VALUES(account_login),
        timezone_offset_minutes=VALUES(timezone_offset_minutes), clock_status=VALUES(clock_status),
        clock_residual_ms=VALUES(clock_residual_ms), last_calibrated_at=NOW()`,
    [identity.bridgeUserId, identity.brokerServer, identity.accountLogin, identity.sourceKey,
      clock.timezone_offset_minutes, clock.clock_status, clock.clock_residual_ms])
  }
  const source = await queryOne(`SELECT id FROM market_data_sources
    WHERE bridge_user_id = ? AND source_key = ? LIMIT 1`, [identity.bridgeUserId, identity.sourceKey])
  const now = Date.now()
  if (!observerBootstrap && source && now - (recentSampleAt.get(source.id) || 0) >= 300000) {
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
  const normalized = (Array.isArray(rates) ? rates : [])
    .map(rate => validRate(rate, 0))
    .filter(Boolean)
    .sort((a, b) => Number(a.time_utc_msc) - Number(b.time_utc_msc))
  const ordered = mergeRates([], normalized, CACHE_LIMIT)
  const suspicious = []
  const expectedClosures = []
  for (let index = 1; index < normalized.length; index++) {
    if (Number(normalized[index - 1].time_utc_msc) === Number(normalized[index].time_utc_msc)) {
      suspicious.push({
        reason:'duplicate_open_time',
        from_utc_msc:Number(normalized[index - 1].time_utc_msc),
        to_utc_msc:Number(normalized[index].time_utc_msc),
        gap_ms:0,
        missing_bar_count:0,
      })
    }
  }
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
    // Without a broker-session calendar, only a bounded rollover gap or a
    // weekend is safe to classify as an expected closure. A long weekday gap
    // may be missing data and must fail Chan reliability closed.
    const scheduledDailyClosure = crossesBrokerDate
      && gapMs >= 30 * 60 * 1000 && gapMs <= MAX_EXPECTED_DAILY_CLOSURE_MS
    const expectedClosure = scheduledDailyClosure || crossesWeekendUtc(previousUtcMs, currentUtcMs)
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
  const hotRaw = await cacheGetJSON(key)
  const hot = Array.isArray(hotRaw)
    ? hotRaw.map(rate => validRate(rate, 0)).filter(Boolean)
    : null
  const required = Math.max(1, count - 1)
  if (Array.isArray(hot) && hot.length >= required) return { rates: hot.slice(-count), layer: 'redis' }
  const rows = await queryAll(`SELECT broker_symbol, broker_time AS time, open_time_utc_msc AS time_utc_msc,
    open_price AS open, high_price AS high, low_price AS low, close_price AS close,
    tick_volume, spread FROM market_candles
    WHERE source_id = ? AND standard_symbol = ? AND timeframe = ? AND open_time_utc_msc <= ?
    ORDER BY open_time_utc_msc DESC LIMIT ?`, [sourceId, standardSymbol, timeframe,
    Date.now() + FUTURE_RATE_TOLERANCE_MS, Math.min(CACHE_LIMIT, count)])
  const stored = rows.reverse().map(row => ({ ...row, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), tick_volume: Number(row.tick_volume), spread: Number(row.spread) }))
  const rates = mergeRates(stored, Array.isArray(hot) ? hot : [], count)
  if (rates.length) await cacheSetJSON(key, rates, CACHE_TTL_SECONDS)
  const layer = rates.length >= required ? 'mysql' : Array.isArray(hot) && hot.length ? 'redis_partial' : rates.length ? 'mysql_partial' : 'cold'
  return { rates, layer }
}

async function saveClosedCache(sourceId, standardSymbol, timeframe, rates) {
  if (!sourceId || !rates.length) return
  const key = cacheKey(sourceId, standardSymbol, timeframe)
  const previous = closedCacheWrites.get(key) || Promise.resolve()
  const write = previous.catch(() => {}).then(async () => {
    const existing = await cacheGetJSON(key)
    // Lightweight count=3 probes share this cache with 200/2000-candle chart
    // requests. Never let a smaller response truncate a larger hot history.
    const next = Array.isArray(existing) && existing.length > rates.length
      ? mergeRates(existing, rates, CACHE_LIMIT)
      : rates.slice(-CACHE_LIMIT)
    await cacheSetJSON(key, next, CACHE_TTL_SECONDS)
  })
  closedCacheWrites.set(key, write)
  try {
    await write
  } finally {
    if (closedCacheWrites.get(key) === write) closedCacheWrites.delete(key)
  }
}

async function ensureSourceBestEffort(bridgeUserId, clock, sampleRate) {
  try {
    return { sourceId:await ensureSource(bridgeUserId, clock, sampleRate), failures:[] }
  } catch (error) {
    console.error('[MarketData] source metadata write failed:', error.message)
    return { sourceId:null, failures:['source_metadata'] }
  }
}

async function writeClosedWindowBestEffort(sourceId, brokerSymbol, timeframe, closedRates, cacheRates = null) {
  let persistedCount = 0
  const failures = []
  try {
    persistedCount = await persistClosedCandles(sourceId, brokerSymbol, timeframe, closedRates)
  } catch (error) {
    failures.push('mysql')
    console.error('[MarketData] candle persistence failed:', error.message)
  }
  if (Array.isArray(cacheRates) && cacheRates.length > 0) {
    try {
      await saveClosedCache(sourceId, stripBrokerSuffix(brokerSymbol), timeframe, cacheRates)
    } catch (error) {
      failures.push('redis')
      console.error('[MarketData] candle cache write failed:', error.message)
    }
  }
  return { persistedCount, failures }
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
    await queryRun('DELETE FROM market_candles WHERE timeframe = ? AND open_time_utc_msc < ? LIMIT 10000', [timeframe, cutoff])
  }
}

async function getPlatformRatesCore(requestUserId, platformUserId, params) {
  const symbol = String(params.symbol || '').trim()
  const timeframe = String(params.timeframe || 'M30').toUpperCase()
  const countLimit = params.review_window === true ? 5000 : CACHE_LIMIT
  const count = Math.min(countLimit, Math.max(2, Number(params.count) || 100))
  if (platformUserId) {
    const platformRoute = params.platform_route && typeof params.platform_route === 'object'
      ? {
          terminal_instance_id:params.platform_route.terminal_instance_id,
          account_ref:params.platform_route.account_ref,
        }
      : {}
    const clock = getPlatformMarketClockState(platformUserId, params.platform_trading_account_id)
    const rangeStartUtcMs = Number(params.start_utc_msc)
    const rangeEndUtcMs = Number(params.end_utc_msc)
    const exactReviewRange = params.review_window === true && Number.isFinite(rangeStartUtcMs)
      && Number.isFinite(rangeEndUtcMs) && rangeStartUtcMs > 0 && rangeEndUtcMs > rangeStartUtcMs
    if (exactReviewRange) {
      const response = await mt5Bridge(platformUserId, 'rates', { symbol, timeframe, count,
        ...platformRoute,
        start_utc_msc:rangeStartUtcMs, end_utc_msc:rangeEndUtcMs }, { timeoutMs:30000, noFallback:true })
      if (response?.status === 'success' && Array.isArray(response.rates) && response.rates.length) {
        const effectiveClock = effectiveResponseClock(clock, response, response.rates)
        const closureCutoffUtcMs = Math.min(rangeEndUtcMs, Date.now())
        const intervalMs = timeframeIntervalMs(timeframe)
        const closedRates = response.rates.map(rate => validRate(rate, effectiveClock.timezone_offset_minutes))
          .filter(rate => rate
            && rate.time_utc_msc >= rangeStartUtcMs
            && rate.time_utc_msc < rangeEndUtcMs
            && rate.time_utc_msc + intervalMs <= closureCutoffUtcMs)
        if (!closedRates.length) {
          return { status:'error', error:'rates_timestamp_invalid', message:'桥接返回的 K 线时间无效' }
        }
        const brokerSymbol = response.symbol || symbol
        const ensured = await ensureSourceBestEffort(platformUserId, effectiveClock, response.rates.at(-1))
        const sourceId = ensured.sourceId
        const written = await writeClosedWindowBestEffort(sourceId, brokerSymbol, timeframe, closedRates)
        const writeFailures = [...ensured.failures, ...written.failures]
        const rangeIntegrity = inspectRateContinuity(closedRates, timeframe)
        const rangeGapUnresolved = rangeIntegrity.status === 'suspicious_gap'
        return { ...response, rates:closedRates, market_meta:{
          source:'platform_admin_bridge_range', source_user_id:platformUserId, source_id:sourceId,
          broker_symbol:brokerSymbol, timeframe, timezone_offset_minutes:effectiveClock.timezone_offset_minutes,
          platform:effectiveClock.platform || null,
          clock_status:effectiveClock.clock_status, closed_candles_persisted:closedRates.length,
          clock_sample_age_ms:effectiveClock.clock_sample_age_ms,
          closed_candles_written:written.persistedCount, cache_layer:'exact_range', live_candle_cached:false,
          cache_write_degraded:writeFailures.length > 0,
          cache_write_failure_layers:writeFailures,
          last_bar_closed:true,
          cache_internal_gap_detected:rangeGapUnresolved,
          cache_internal_gap_unresolved:rangeGapUnresolved,
          cache_internal_gap_details:rangeGapUnresolved ? rangeIntegrity.suspicious_gaps.slice(0, 3) : [],
          range_start_utc_msc:rangeStartUtcMs, range_end_utc_msc:rangeEndUtcMs,
        } }
      }
      if (response?.status && response.status !== 'success') return response
      return {
        status:'error',
        error:'rates_range_empty',
        message:response?.message || response?.error || '桥接未返回请求范围内的历史 K 线',
      }
    }
    const source = await findSource(platformUserId, clock).catch(() => ({ id: null }))
    const standardSymbol = stripBrokerSuffix(symbol)
    const structureAnchor = await loadChanStructureAnchor(source.id, standardSymbol, timeframe)
    const cachedResult = await loadClosedCandles(source.id, standardSymbol, timeframe, count).catch(() => ({ rates: [], layer: 'cold' }))
    const probeOnly = cachedResult.rates.length >= count - 1
    const fetchCount = probeOnly ? 3 : count + 1
    let response = await mt5Bridge(platformUserId, 'rates', {
      symbol, timeframe, count:fetchCount, ...platformRoute,
    }, { timeoutMs: 15000, noFallback: true })
    if (response?.status === 'success' && Array.isArray(response.rates) && response.rates.length) {
      let rates = response.rates
      let effectiveClock = effectiveResponseClock(clock, response, rates)
      let split = splitRatesByClosure(rates, timeframe, effectiveClock.timezone_offset_minutes)
      if (!split.closedRates.length && !split.liveRates.length) {
        return { status:'error', error:'rates_timestamp_invalid', message:'桥接返回的 K 线时间无效' }
      }
      let closedRates = split.closedRates
      const cachedIntegrity = inspectRateContinuity(cachedResult.rates, timeframe)
      const effectiveIdentity = sourceIdentity(platformUserId, effectiveClock)
      let sourceIdentityChanged = Boolean(source.id && source.sourceKey && source.sourceKey !== effectiveIdentity.sourceKey)
      const boundaryGapDetected = probeOnly && !ratesJoinAtCacheBoundary(cachedResult.rates, closedRates)
      const internalGapRefillAttempted = probeOnly
        && shouldAttemptInternalGapRefill(source.id, standardSymbol, timeframe, cachedIntegrity)
      const windowRefillNeeded = sourceIdentityChanged || boundaryGapDetected || internalGapRefillAttempted
      if (windowRefillNeeded) {
        const refill = await mt5Bridge(platformUserId, 'rates', {
          symbol, timeframe, count:count + 1, ...platformRoute,
        }, { timeoutMs: 15000, noFallback: true })
        if (refill?.status !== 'success' || !Array.isArray(refill.rates) || !refill.rates.length) {
          return { status: 'error', error: 'rates_gap_refill_failed', message: refill?.message || refill?.error || 'K 线缓存缺口补齐失败' }
        }
        response = refill
        rates = refill.rates
        effectiveClock = effectiveResponseClock(clock, response, rates)
        const refillIdentity = sourceIdentity(platformUserId, effectiveClock)
        sourceIdentityChanged = Boolean(source.id && source.sourceKey
          && source.sourceKey !== refillIdentity.sourceKey)
        split = splitRatesByClosure(rates, timeframe, effectiveClock.timezone_offset_minutes)
        if (!split.closedRates.length && !split.liveRates.length) {
          return { status:'error', error:'rates_timestamp_invalid', message:'桥接返回的 K 线时间无效' }
        }
        closedRates = split.closedRates
      }
      const freshIntegrity = inspectRateContinuity(closedRates, timeframe)
      const internalGapDetected = (!sourceIdentityChanged && cachedIntegrity.status === 'suspicious_gap') || freshIntegrity.status === 'suspicious_gap'
      const cachedGapStillStored = !windowRefillNeeded && cachedIntegrity.status === 'suspicious_gap'
      const internalGapUnresolved = freshIntegrity.status === 'suspicious_gap' || cachedGapStillStored
      const unresolvedGapDetails = freshIntegrity.status === 'suspicious_gap'
        ? freshIntegrity.suspicious_gaps : cachedIntegrity.suspicious_gaps
      const brokerSymbol = response.symbol || symbol
      const stored = mergeRates(windowRefillNeeded ? [] : cachedResult.rates, closedRates, CACHE_LIMIT)
      const ensured = await ensureSourceBestEffort(platformUserId, effectiveClock, rates.at(-1))
      const sourceId = ensured.sourceId
      const finalSourceIdentityChanged = Boolean(sourceId)
        && (sourceIdentityChanged || Number(source.id) !== Number(sourceId))
      const effectiveStructureAnchor = finalSourceIdentityChanged
        ? await loadChanStructureAnchor(sourceId, standardSymbol, timeframe)
        : structureAnchor
      const written = await writeClosedWindowBestEffort(sourceId, brokerSymbol, timeframe, closedRates, stored)
      const writeFailures = [...ensured.failures, ...written.failures]
      return {
        ...response,
        rates: mergeRates(stored, split.liveRates, count),
        market_meta: {
          source: 'platform_admin_bridge', source_user_id: platformUserId,
          source_id: sourceId, broker_symbol: brokerSymbol, timeframe,
          platform: effectiveClock.platform || null,
          timezone_offset_minutes: effectiveClock.timezone_offset_minutes,
          clock_status: effectiveClock.clock_status,
          clock_sample_age_ms:effectiveClock.clock_sample_age_ms,
          closed_candles_persisted: stored.length,
          closed_candles_written: written.persistedCount,
          cache_layer: sourceIdentityChanged ? 'cold' : cachedResult.layer,
          cache_write_degraded: writeFailures.length > 0,
          cache_write_failure_layers: writeFailures,
          cache_gap_refilled: windowRefillNeeded,
          cache_source_identity_refilled: sourceIdentityChanged,
          cache_boundary_gap_refilled: boundaryGapDetected,
          cache_internal_gap_detected: internalGapDetected,
          cache_internal_gap_refill_attempted: internalGapRefillAttempted,
          cache_internal_gap_unresolved: internalGapUnresolved,
          cache_internal_gap_details: internalGapUnresolved ? unresolvedGapDetails.slice(0, 3) : [],
          last_bar_closed: split.lastBarClosed,
          live_candle_cached: false,
          chan_structure_anchor_utc_msc:Number(effectiveStructureAnchor?.anchor_time_utc_msc) || null,
          chan_last_confirmed_segment_utc_msc:Number(effectiveStructureAnchor?.last_confirmed_segment_time_utc_msc) || null,
          chan_structure_anchor_core_stable_id:effectiveStructureAnchor?.bootstrap_core_stable_id || null,
          chan_structure_anchor_entry_segment_stable_id:effectiveStructureAnchor?.bootstrap_entry_segment_stable_id || null,
          chan_structure_anchor_observation_time_utc_msc:
            Number(effectiveStructureAnchor?.bootstrap_observation_time_utc_msc) || null,
        },
      }
    }
  }
  if (platformUserId && params.require_platform_source === true) {
    return { status:'error', error:'platform_market_source_unavailable', message:'默认观摩源暂时无法提供该品种行情' }
  }
  const fallbackClock = getPlatformMarketClockState(requestUserId)
  const existingFallbackSource = await findSource(requestUserId, fallbackClock)
    .catch(() => ({ id:null }))
  const fallbackStandardSymbol = stripBrokerSuffix(symbol)
  const fallbackRangeStart = Number(params.start_utc_msc)
  const fallbackRangeEnd = Number(params.end_utc_msc)
  const fallbackReviewRange = params.review_window === true && Number.isFinite(fallbackRangeStart)
    && Number.isFinite(fallbackRangeEnd) && fallbackRangeStart > 0 && fallbackRangeEnd > fallbackRangeStart
  const fallbackCached = fallbackReviewRange
    ? { rates:[], layer:'exact_range' }
    : await loadClosedCandles(existingFallbackSource.id, fallbackStandardSymbol, timeframe, count)
      .catch(() => ({ rates:[], layer:'cold' }))
  const fallbackProbeOnly = !fallbackReviewRange && fallbackCached.rates.length >= count - 1
  const fallbackFetchCount = fallbackReviewRange ? count : (fallbackProbeOnly ? 3 : count + 1)
  let fallback = await mt5Bridge(requestUserId, 'rates', { symbol, timeframe, count:fallbackFetchCount,
    ...(fallbackReviewRange ? { start_utc_msc:fallbackRangeStart, end_utc_msc:fallbackRangeEnd } : {}) },
  { timeoutMs:fallbackReviewRange ? 30000 : 15000, noFallback:true })
  if (fallback?.status !== 'success' || !Array.isArray(fallback.rates) || fallback.rates.length === 0) return fallback

  let effectiveFallbackClock = effectiveResponseClock(fallbackClock, fallback, fallback.rates)
  let fallbackOffset = effectiveFallbackClock.timezone_offset_minutes ?? null
  let fallbackSplit = splitRatesByClosure(fallback.rates, timeframe, fallbackOffset)
  if (fallbackReviewRange) {
    const intervalMs = timeframeIntervalMs(timeframe)
    const closureCutoffUtcMs = Math.min(fallbackRangeEnd, Date.now())
    const closedRates = fallback.rates.map(rate => validRate(rate, fallbackOffset))
      .filter(rate => rate && rate.time_utc_msc >= fallbackRangeStart && rate.time_utc_msc < fallbackRangeEnd
        && rate.time_utc_msc + intervalMs <= closureCutoffUtcMs)
    fallbackSplit = { closedRates, liveRates:[], lastBarClosed:true }
  }
  if (!fallbackSplit.closedRates.length && !fallbackSplit.liveRates.length) {
    return { status:'error', error:'rates_timestamp_invalid', message:'桥接返回的 K 线时间无效' }
  }
  const initialFallbackIdentity = sourceIdentity(requestUserId, effectiveFallbackClock)
  let fallbackIdentityChanged = Boolean(existingFallbackSource.id && existingFallbackSource.sourceKey
    && existingFallbackSource.sourceKey !== initialFallbackIdentity.sourceKey)
  const fallbackCachedIntegrity = inspectRateContinuity(fallbackCached.rates, timeframe)
  const fallbackBoundaryGap = fallbackProbeOnly && !ratesJoinAtCacheBoundary(fallbackCached.rates, fallbackSplit.closedRates)
  const fallbackInternalRefill = fallbackProbeOnly && shouldAttemptInternalGapRefill(
    existingFallbackSource.id, fallbackStandardSymbol, timeframe, fallbackCachedIntegrity)
  const fallbackRefillNeeded = !fallbackReviewRange
    && (fallbackIdentityChanged || fallbackBoundaryGap || fallbackInternalRefill)
  if (fallbackRefillNeeded) {
    const refill = await mt5Bridge(requestUserId, 'rates', { symbol, timeframe, count:count + 1 },
      { timeoutMs:15000, noFallback:true })
    if (refill?.status !== 'success' || !Array.isArray(refill.rates) || refill.rates.length === 0) {
      return { status:'error', error:'rates_gap_refill_failed', message:refill?.message || refill?.error || 'K 线缓存缺口补齐失败' }
    }
    fallback = refill
    effectiveFallbackClock = effectiveResponseClock(fallbackClock, fallback, fallback.rates)
    const refillFallbackIdentity = sourceIdentity(requestUserId, effectiveFallbackClock)
    fallbackIdentityChanged = Boolean(existingFallbackSource.id && existingFallbackSource.sourceKey
      && existingFallbackSource.sourceKey !== refillFallbackIdentity.sourceKey)
    fallbackOffset = effectiveFallbackClock.timezone_offset_minutes ?? null
    fallbackSplit = splitRatesByClosure(fallback.rates, timeframe, fallbackOffset)
  }
  const fallbackIntegrity = inspectRateContinuity(fallbackSplit.closedRates, timeframe)
  const fallbackCachedGapStillStored = !fallbackReviewRange && !fallbackRefillNeeded
    && fallbackCachedIntegrity.status === 'suspicious_gap'
  const fallbackGapUnresolved = fallbackIntegrity.status === 'suspicious_gap' || fallbackCachedGapStillStored
  const fallbackGapDetails = fallbackIntegrity.status === 'suspicious_gap'
    ? fallbackIntegrity.suspicious_gaps : fallbackCachedIntegrity.suspicious_gaps
  const fallbackBrokerSymbol = fallback.symbol || symbol
  const ensuredFallback = await ensureSourceBestEffort(requestUserId, effectiveFallbackClock, fallback.rates.at(-1))
  const fallbackSourceId = ensuredFallback.sourceId
  const fallbackStored = fallbackReviewRange
    ? fallbackSplit.closedRates
    : mergeRates(fallbackRefillNeeded ? [] : fallbackCached.rates, fallbackSplit.closedRates, CACHE_LIMIT)
  const writtenFallback = await writeClosedWindowBestEffort(fallbackSourceId, fallbackBrokerSymbol, timeframe,
    fallbackSplit.closedRates, fallbackReviewRange ? null : fallbackStored)
  const fallbackWriteFailures = [...ensuredFallback.failures, ...writtenFallback.failures]
  const resolvedFallbackStandardSymbol = stripBrokerSuffix(fallbackBrokerSymbol)
  const fallbackStructureAnchor = await loadChanStructureAnchor(
    fallbackSourceId, resolvedFallbackStandardSymbol, timeframe)
  fallback.rates = mergeRates(fallbackStored, fallbackSplit.liveRates, count)
  fallback.market_meta = {
    source:'user_bridge_fallback', source_user_id:requestUserId, broker_symbol:fallbackBrokerSymbol,
    source_id:fallbackSourceId, platform:effectiveFallbackClock.platform || null,
    timeframe, timezone_offset_minutes:fallbackOffset,
    clock_status:effectiveFallbackClock.clock_status || 'unknown',
    clock_sample_age_ms:effectiveFallbackClock.clock_sample_age_ms,
    closed_candles_persisted:fallbackStored.length,
    closed_candles_written:writtenFallback.persistedCount,
    cache_layer:fallbackIdentityChanged ? 'cold' : fallbackCached.layer,
    cache_write_degraded:fallbackWriteFailures.length > 0,
    cache_write_failure_layers:fallbackWriteFailures,
    cache_gap_refilled:fallbackRefillNeeded,
    cache_source_identity_refilled:fallbackIdentityChanged,
    cache_boundary_gap_refilled:fallbackBoundaryGap,
    cache_internal_gap_refill_attempted:fallbackInternalRefill,
    live_candle_cached:false,
    last_bar_closed:fallbackSplit.lastBarClosed,
    cache_internal_gap_detected:(!fallbackIdentityChanged && fallbackCachedIntegrity.status === 'suspicious_gap')
      || fallbackIntegrity.status === 'suspicious_gap',
    cache_internal_gap_unresolved:fallbackGapUnresolved,
    cache_internal_gap_details:fallbackGapUnresolved ? fallbackGapDetails.slice(0, 3) : [],
    chan_structure_anchor_utc_msc:Number(fallbackStructureAnchor?.anchor_time_utc_msc) || null,
    chan_last_confirmed_segment_utc_msc:Number(fallbackStructureAnchor?.last_confirmed_segment_time_utc_msc) || null,
    chan_structure_anchor_core_stable_id:fallbackStructureAnchor?.bootstrap_core_stable_id || null,
    chan_structure_anchor_entry_segment_stable_id:fallbackStructureAnchor?.bootstrap_entry_segment_stable_id || null,
    chan_structure_anchor_observation_time_utc_msc:
      Number(fallbackStructureAnchor?.bootstrap_observation_time_utc_msc) || null,
  }
  return fallback
}

export async function saveChanStructureAnchor(sourceId, symbol, timeframe, structureAnchor) {
  const anchorTime = Number(structureAnchor?.recommended_time_utc_msc)
  const coreStableId = String(structureAnchor?.bootstrap_core_stable_id || '').trim()
  const entrySegmentStableId = String(structureAnchor?.bootstrap_entry_segment_stable_id || '').trim()
  if (!Number.isInteger(Number(sourceId)) || Number(sourceId) <= 0 || !Number.isFinite(anchorTime) || anchorTime <= 0
    || !coreStableId || coreStableId.length > 1024 || !entrySegmentStableId || entrySegmentStableId.length > 255) return false
  const lastConfirmedTime = Number(structureAnchor?.last_confirmed_segment_time_utc_msc)
  const bootstrapObservationTime = Number(structureAnchor?.bootstrap_observation_time_utc_msc)
  if (!Number.isFinite(lastConfirmedTime) || lastConfirmedTime < anchorTime) return false
  if (!Number.isFinite(bootstrapObservationTime) || bootstrapObservationTime < lastConfirmedTime) return false
  await queryRun(`INSERT INTO chan_structure_anchors
    (source_id, standard_symbol, timeframe, algorithm_version, anchor_time_utc_msc,
      last_confirmed_segment_time_utc_msc, bootstrap_core_stable_id, bootstrap_entry_segment_stable_id,
      bootstrap_observation_time_utc_msc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      bootstrap_core_stable_id = IF(algorithm_version = VALUES(algorithm_version)
        AND COALESCE(bootstrap_observation_time_utc_msc, 0) > VALUES(bootstrap_observation_time_utc_msc),
        bootstrap_core_stable_id, VALUES(bootstrap_core_stable_id)),
      bootstrap_entry_segment_stable_id = IF(algorithm_version = VALUES(algorithm_version)
        AND COALESCE(bootstrap_observation_time_utc_msc, 0) > VALUES(bootstrap_observation_time_utc_msc),
        bootstrap_entry_segment_stable_id, VALUES(bootstrap_entry_segment_stable_id)),
      anchor_time_utc_msc = IF(algorithm_version = VALUES(algorithm_version),
        IF(COALESCE(bootstrap_observation_time_utc_msc, 0) > VALUES(bootstrap_observation_time_utc_msc),
          anchor_time_utc_msc, VALUES(anchor_time_utc_msc)), VALUES(anchor_time_utc_msc)),
      last_confirmed_segment_time_utc_msc = IF(algorithm_version = VALUES(algorithm_version),
        IF(COALESCE(bootstrap_observation_time_utc_msc, 0) > VALUES(bootstrap_observation_time_utc_msc),
          last_confirmed_segment_time_utc_msc, VALUES(last_confirmed_segment_time_utc_msc)),
        VALUES(last_confirmed_segment_time_utc_msc)),
      bootstrap_observation_time_utc_msc = IF(algorithm_version = VALUES(algorithm_version),
        GREATEST(COALESCE(bootstrap_observation_time_utc_msc, 0), VALUES(bootstrap_observation_time_utc_msc)),
        VALUES(bootstrap_observation_time_utc_msc)),
      algorithm_version = VALUES(algorithm_version)`,
  [Number(sourceId), stripBrokerSuffix(symbol), String(timeframe || '').toUpperCase(), CHAN_ALGORITHM_VERSION, anchorTime,
    lastConfirmedTime, coreStableId, entrySegmentStableId, bootstrapObservationTime])
  return true
}

export async function getPlatformRates(requestUserId, params = {}) {
  maybeCleanupMarketData().catch(error => console.error('[MarketData] cleanup failed:', error.message))
  let platformUserId
  let requestParams = params
  if (params.prefer_user_source === true) {
    platformUserId = null
  } else if (params.browser_market_view === true) {
    const source = await getDefaultObserverSource().catch(() => null)
    const supported = source ? observerSourceSupportsSymbol(source, params.symbol) : false
    if (source && supported) {
      platformUserId = await getActivePlatformBridgeUserId()
      if (!platformUserId) {
        return { status:'error', error:'observer_source_offline', message:'默认观摩源暂时离线' }
      }
      const route = getBridgeDataRoute(Number(source.bridge_user_id), source.trading_account_id,
        { strictAccount:true })
      requestParams = {
        ...params,
        require_platform_source:true,
        platform_trading_account_id:Number(source.trading_account_id) || null,
        platform_route:route ? {
          terminal_instance_id:route.terminal_instance_id,
          account_ref:route.account_ref,
        } : null,
      }
    } else {
      platformUserId = null
    }
  } else {
    platformUserId = await getActivePlatformBridgeUserId()
  }
  const identityClock = getPlatformMarketClockState(platformUserId || requestUserId,
    requestParams.platform_trading_account_id)
  requestParams = {
    ...requestParams,
    market_platform_hint:String(requestParams.platform_route?.platform || identityClock?.platform || 'unknown').toLowerCase(),
  }
  const key = buildRatesRequestKey(requestUserId, platformUserId, requestParams)
  if (inFlightRates.has(key)) return inFlightRates.get(key)
  const request = getPlatformRatesCore(requestUserId, platformUserId, requestParams).finally(() => inFlightRates.delete(key))
  inFlightRates.set(key, request)
  return request
}

export function buildRatesRequestKey(requestUserId, platformUserId, params = {}) {
  const reviewWindow = params.review_window === true
  const countLimit = reviewWindow ? 5000 : CACHE_LIMIT
  const count = Math.min(countLimit, Math.max(2, Number(params.count) || 100))
  const range = reviewWindow ? `${Number(params.start_utc_msc) || 0}-${Number(params.end_utc_msc) || 0}` : 'current'
  const routeKey = params.platform_route?.terminal_instance_id
    || params.platform_trading_account_id || 'default'
  const platformKey = String(params.market_platform_hint || params.platform_route?.platform || 'unknown').toLowerCase()
  return `${platformUserId || `user-${requestUserId}`}:${routeKey}:${platformKey}:${String(params.symbol || '').trim()}:${String(params.timeframe || 'M30').toUpperCase()}:${reviewWindow ? 'review' : 'live'}:${range}:${count}`
}

export async function getPlatformMarketStatus() {
  const platformUserId = await getActivePlatformBridgeUserId()
  return platformUserId ? getPlatformMarketClockState(platformUserId) : { connected: false, clock_status: 'offline' }
}
