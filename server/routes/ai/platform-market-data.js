import { queryAll, queryOne, queryRun } from '../../db.js'
import { cacheGetJSON, cacheSetJSON } from '../../redis.js'
import { getActivePlatformBridgeUserId, getBridgeDataRoute, getPlatformMarketClockState } from '../../bridge-ws.js'
import { mt5Bridge } from './market-data.js'
import { CHAN_ALGORITHM_VERSION, stripBrokerSuffix, timeframeIntervalMs } from './utils.js'
import { getDefaultObserverSource, observerSourceSupportsSymbol } from './observer-channels.js'
import { classifyMarketClosure, MARKET_SESSION_CALENDAR_VERSION, MARKET_SESSION_ENGINE_VERSION } from './market-session-calendar.js'
import { getMarketSessionPolicyMode, resolveMarketSessionPolicy } from './market-session-policy.js'

const CACHE_LIMIT = 2000
const CACHE_TTL_SECONDS = 24 * 60 * 60
const WRITE_BATCH_SIZE = 250
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const VERIFIED_SOURCE_GAP_TTL_MS = 24 * 60 * 60 * 1000
const MAX_VERIFIED_SOURCE_GAPS = 2048
const MAX_EXPECTED_DAILY_CLOSURE_MS = 4 * 60 * 60 * 1000
const FUTURE_RATE_TOLERANCE_MS = 2 * 60 * 1000
const recentSampleAt = new Map()
const inFlightRates = new Map()
// A cache gap that the same terminal has independently returned is an
// observed source property, not a cache corruption. Keep that verification
// in-process so every probe does not issue the same bounded Bridge request.
const verifiedSourceGaps = new Map()
const closedCacheWrites = new Map()
let lastCleanupAt = 0

function continuityMeta(integrity) {
  const policy = integrity?.policy || {}
  return {
    continuity_engine_version:integrity?.engine_version || MARKET_SESSION_ENGINE_VERSION,
    continuity_policy_id:policy.policy_id || null,
    continuity_policy_version:policy.policy_version || null,
    continuity_policy_hash:policy.policy_hash || null,
    continuity_policy_match:Boolean(policy.matched || integrity?.policy_match),
    closure_components:Array.isArray(integrity?.components)
      ? integrity.components.slice(0, 16) : [],
    uncovered_ranges:Array.isArray(integrity?.uncovered_ranges)
      ? integrity.uncovered_ranges.slice(0, 16) : [],
    // Short aliases make the frozen market metadata usable by newer callers
    // without removing the explicit continuity_* fields used by old callers.
    policy,
    engine:integrity?.engine_version || MARKET_SESSION_ENGINE_VERSION,
    components:Array.isArray(integrity?.components) ? integrity.components.slice(0, 16) : [],
    uncovered:Array.isArray(integrity?.uncovered_ranges) ? integrity.uncovered_ranges.slice(0, 16) : [],
    audit_expected_closures:Array.isArray(integrity?.audit_expected_closures)
      ? integrity.audit_expected_closures.slice(0, 16) : [],
    audit_suspicious_gaps:Array.isArray(integrity?.audit_suspicious_gaps)
      ? integrity.audit_suspicious_gaps.slice(0, 16) : [],
    continuity_policy_mode:policy.mode || 'off',
  }
}

function marketSourceIdentityMeta(bridgeUserId, clock = {}) {
  const identity = sourceIdentity(bridgeUserId, clock)
  return {
    broker_server:identity.brokerServer === 'unknown' ? null : identity.brokerServer,
    account_login:identity.accountLogin === '0' ? null : identity.accountLogin,
    source_key:hasStableSourceIdentity(identity) ? identity.sourceKey : null,
  }
}

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

export function inspectRateContinuity(rates, timeframe, options = {}) {
  const intervalMs = timeframeIntervalMs(timeframe)
  const ignoreSessionPolicy = options.ignoreMarketSessionPolicy === true
  const configuredMode = options.marketSessionPolicyMode || options.market_session_policy_mode
    || (ignoreSessionPolicy ? 'off' : getMarketSessionPolicyMode(options.env || process.env))
  const initialPolicyMatch = resolveMarketSessionPolicy({
    platform:options.platform,
    broker_server:options.brokerServer || options.broker_server,
    standard_symbol:options.standardSymbol || options.standard_symbol || options.symbol,
  }, { env:ignoreSessionPolicy ? {} : (options.env || process.env) })
  const initialPolicy = {
    mode:configuredMode,
    matched:Boolean(initialPolicyMatch?.matched),
    policy_id:initialPolicyMatch?.policy_id || null,
    policy_version:initialPolicyMatch?.policy_version || null,
    policy_hash:initialPolicyMatch?.policy_hash || null,
    reason:initialPolicyMatch?.reason || null,
  }
  const normalized = (Array.isArray(rates) ? rates : [])
    .map(rate => validRate(rate, 0))
    .filter(Boolean)
    .sort((a, b) => Number(a.time_utc_msc) - Number(b.time_utc_msc))
  const ordered = mergeRates([], normalized, CACHE_LIMIT)
  const suspicious = []
  const expectedClosures = []
  const closureComponents = []
  const uncoveredRanges = []
  const auditExpectedClosures = []
  const auditSuspiciousGaps = []
  const continuityReasons = new Set()
  let unknownSessionGapCount = 0
  for (let index = 1; index < normalized.length; index++) {
    if (Number(normalized[index - 1].time_utc_msc) === Number(normalized[index].time_utc_msc)) {
      continuityReasons.add('duplicate_open_time')
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
    const strictSessionPolicy = options.strictSessionPolicy === true
    // The strict path accepts only a closure returned by the versioned session
    // classifier.  The compatibility path is retained for old callers that
    // have not supplied clock/session metadata yet; production market reads
    // pass strictSessionPolicy with the terminal clock evidence.
    const scheduledDailyClosure = crossesBrokerDate
      && gapMs >= 30 * 60 * 1000 && gapMs <= MAX_EXPECTED_DAILY_CLOSURE_MS
    const calendarClosure = ignoreSessionPolicy ? null : classifyMarketClosure(previousUtcMs, currentUtcMs, timeframe, {
      intervalMs,
      standardSymbol:options.standardSymbol || options.symbol || '',
      platform:options.platform,
      brokerServer:options.brokerServer || options.broker_server,
      strictSessionPolicy,
      marketSessionPolicyMode:options.marketSessionPolicyMode || options.market_session_policy_mode,
      env:options.env || process.env,
      timezoneOffsetMinutes:options.timezoneOffsetMinutes ?? options.timezone_offset_minutes,
      sessionTimezone:options.sessionTimezone || options.session_timezone,
      clockStatus:options.clockStatus || options.clock_status,
      policyVersion:options.policyVersion || options.marketSessionPolicyVersion,
      startBrokerTime:previous.time,
      endBrokerTime:current.time,
    })
    const policyEnforced = !ignoreSessionPolicy && calendarClosure?.policy_enforced === true
    const policyExpected = policyEnforced && calendarClosure?.expected === true
    const auditPolicyMatched = calendarClosure?.audit_only === true && calendarClosure?.policy_match === true
    if (auditPolicyMatched) {
      const auditDetail = { from_utc_msc:previousUtcMs, to_utc_msc:currentUtcMs, gap_ms:gapMs,
        missing_bar_count:Math.max(1, Math.round(gapMs / intervalMs) - 1),
        classification:calendarClosure.classification, reason:calendarClosure.reason,
        components:calendarClosure.components || [], uncovered_ranges:calendarClosure.uncovered_ranges || [],
      }
      if (calendarClosure.expected === true) auditExpectedClosures.push(auditDetail)
      else auditSuspiciousGaps.push(auditDetail)
    }
    const legacyExpected = !ignoreSessionPolicy && Boolean(calendarClosure?.known === true
      && ['weekend_closure', 'holiday_closure'].includes(calendarClosure.classification))
    if (!ignoreSessionPolicy && strictSessionPolicy && (calendarClosure?.classification === 'unknown_session' || calendarClosure?.known === false)) {
      unknownSessionGapCount += 1
      continuityReasons.add(calendarClosure.reason || 'market_session_policy_unavailable')
    } else if (!ignoreSessionPolicy && strictSessionPolicy && !policyEnforced && !calendarClosure && scheduledDailyClosure) {
      // The versioned calendar deliberately does not guess broker-specific
      // daily maintenance. Keep the gap fail-closed, but expose why it was
      // not silently treated as an ordinary internal hole.
      continuityReasons.add('daily_session_policy_missing')
    }
    const expectedClosure = ignoreSessionPolicy ? false : strictSessionPolicy
      ? (configuredMode === 'enforce' ? policyExpected : legacyExpected)
      : Boolean(calendarClosure?.known === true) || scheduledDailyClosure || crossesWeekendUtc(previousUtcMs, currentUtcMs)
    if (strictSessionPolicy && configuredMode === 'audit' && calendarClosure?.audit_only === true
      && calendarClosure.expected === true && !expectedClosure) {
      continuityReasons.add('daily_session_policy_missing')
    }
    const detail = {
      from_utc_msc: previousUtcMs,
      to_utc_msc: currentUtcMs,
      gap_ms: gapMs,
      missing_bar_count: Math.max(1, Math.round(gapMs / intervalMs) - 1),
    }
    if (expectedClosure) expectedClosures.push({
      ...detail,
      classification:calendarClosure?.classification
        || (crossesWeekendUtc(previousUtcMs, currentUtcMs) ? 'weekend_closure' : 'scheduled_daily_closure'),
      reason:calendarClosure?.reason || (scheduledDailyClosure ? 'daily_rollover' : 'weekend'),
      calendar_version:calendarClosure?.calendar_version || MARKET_SESSION_CALENDAR_VERSION,
      ...(calendarClosure?.components ? { components:calendarClosure.components } : {}),
      ...(calendarClosure?.policy ? { policy:calendarClosure.policy } : {}),
    })
    else {
      const reason = calendarClosure?.reason
        || (strictSessionPolicy && configuredMode === 'audit' && calendarClosure?.expected === true
          ? 'daily_session_policy_missing' : 'market_open_bars_missing')
      const suspiciousGap = { ...detail, reason }
      if (calendarClosure?.policy) suspiciousGap.policy = calendarClosure.policy
      if (calendarClosure?.uncovered_ranges?.length) {
        suspiciousGap.uncovered_ranges = calendarClosure.uncovered_ranges
        calendarClosure.uncovered_ranges.forEach(range => {
          const previousRange = uncoveredRanges.at(-1)
          if (previousRange && range.from_utc_msc <= previousRange.to_utc_msc + intervalMs) {
            previousRange.to_utc_msc = Math.max(previousRange.to_utc_msc, range.to_utc_msc)
            previousRange.missing_bar_count += range.missing_bar_count
          } else uncoveredRanges.push({ ...range })
        })
      } else if (reason === 'market_open_bars_missing') {
        uncoveredRanges.push({ from_utc_msc:previousUtcMs + intervalMs, to_utc_msc:currentUtcMs - intervalMs,
          missing_bar_count:detail.missing_bar_count })
      }
      suspicious.push(suspiciousGap)
    }
    if (Array.isArray(calendarClosure?.components)) {
      for (const component of calendarClosure.components) {
        const existing = closureComponents.find(item => item.kind === component.kind && item.reason === component.reason)
        if (existing) existing.count += Number(component.count) || 1
        else closureComponents.push({ ...component })
      }
    }
  }
  const continuityStatus = unknownSessionGapCount > 0
    ? 'unknown_session'
    : suspicious.length > 0 ? 'suspicious_gap'
      : continuityReasons.size > 0 ? 'policy_missing' : 'reliable'
  const firstClosure = expectedClosures[0] || null
  const firstSuspicious = suspicious[0] || null
  const firstPolicy = firstClosure?.policy || firstSuspicious?.policy || null
  return {
    status: suspicious.length ? 'suspicious_gap' : 'ok',
    suspicious_gaps: suspicious,
    expected_closures: expectedClosures,
    continuity_status:continuityStatus,
    continuity_reason:[...continuityReasons][0] || null,
    continuity_reasons:[...continuityReasons],
    unknown_session_gap_count:unknownSessionGapCount,
    engine_version:calendarClosureEngineVersion(options),
    engine:calendarClosureEngineVersion(options),
    policy:firstPolicy || initialPolicy,
    policy_match:Boolean(firstPolicy?.matched ?? initialPolicy.matched),
    components:closureComponents,
    uncovered_ranges:uncoveredRanges,
    uncovered:uncoveredRanges,
    audit_expected_closures:auditExpectedClosures,
    audit_suspicious_gaps:auditSuspiciousGaps,
  }
}

function calendarClosureEngineVersion(options = {}) {
  return options.marketSessionEngineVersion || MARKET_SESSION_ENGINE_VERSION
}

function timeGapDetails(integrity) {
  return (Array.isArray(integrity?.suspicious_gaps) ? integrity.suspicious_gaps : [])
    .filter(gap => Number(gap?.gap_ms) > 0 && gap?.reason !== 'duplicate_open_time'
      && Number.isFinite(Number(gap?.from_utc_msc)) && Number.isFinite(Number(gap?.to_utc_msc)))
}

function duplicateGapDetected(integrity) {
  return (Array.isArray(integrity?.suspicious_gaps) ? integrity.suspicious_gaps : [])
    .some(gap => gap?.reason === 'duplicate_open_time')
}

function sourceGapKey(sourceId, sourceKey, standardSymbol, timeframe, gap) {
  return [sourceId || 0, sourceKey || '', standardSymbol, timeframe,
    Number(gap.from_utc_msc), Number(gap.to_utc_msc)].join(':')
}

function getVerifiedSourceGap(key, now = Date.now()) {
  const record = verifiedSourceGaps.get(key)
  if (!record) return null
  if (now - Number(record.verified_at || 0) >= VERIFIED_SOURCE_GAP_TTL_MS) {
    verifiedSourceGaps.delete(key)
    return null
  }
  return record
}

function rememberVerifiedSourceGap(key, record) {
  if (verifiedSourceGaps.size >= MAX_VERIFIED_SOURCE_GAPS) {
    const oldest = [...verifiedSourceGaps.entries()]
      .sort((left, right) => Number(left[1]?.verified_at || 0) - Number(right[1]?.verified_at || 0))[0]
    if (oldest) verifiedSourceGaps.delete(oldest[0])
  }
  verifiedSourceGaps.set(key, record)
}

function expectedGapTimes(gap, intervalMs) {
  const from = Number(gap?.from_utc_msc)
  const to = Number(gap?.to_utc_msc)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || !intervalMs) return null
  const steps = (to - from) / intervalMs
  if (!Number.isInteger(steps) || steps < 2 || steps > CACHE_LIMIT - 1) return null
  const times = []
  for (let cursor = from + intervalMs; cursor < to; cursor += intervalMs) times.push(cursor)
  return times
}

function normalizeGapVerificationRates(response, clock, symbol, timeframe, startUtcMs, endUtcMs,
  expectedObservedTimes = [], expectedMissingTimes = []) {
  if (response?.status !== 'success' || !Array.isArray(response.rates) || !response.rates.length) {
    return { error:'rates_gap_verification_failed' }
  }
  const normalized = response.rates.map(rate => validRate(rate, clock.timezone_offset_minutes)).filter(Boolean)
  if (normalized.length !== response.rates.length) return { error:'rates_gap_verification_invalid_timestamp' }
  normalized.sort((left, right) => Number(left.time_utc_msc) - Number(right.time_utc_msc))
  for (let index = 1; index < normalized.length; index += 1) {
    if (Number(normalized[index].time_utc_msc) === Number(normalized[index - 1].time_utc_msc)) {
      return { error:'rates_gap_verification_duplicate_open_time' }
    }
  }
  const symbolBase = stripBrokerSuffix(symbol).toUpperCase()
  if (response.symbol && stripBrokerSuffix(response.symbol).toUpperCase() !== symbolBase) {
    return { error:'rates_gap_verification_symbol_changed' }
  }
  const inWindow = normalized.filter(rate => Number(rate.time_utc_msc) >= startUtcMs
    && Number(rate.time_utc_msc) < endUtcMs)
  if (!inWindow.length || !inWindow.some(rate => Number(rate.time_utc_msc) === startUtcMs)
    || !inWindow.some(rate => Number(rate.time_utc_msc) === endUtcMs - timeframeIntervalMs(timeframe))) {
    return { error:'rates_gap_verification_window_incomplete' }
  }
  const bridgeTimes = new Set(inWindow.map(rate => Number(rate.time_utc_msc)))
  const missingObservedTimes = expectedObservedTimes
    .map(Number).filter(time => Number.isFinite(time) && !bridgeTimes.has(time))
  if (missingObservedTimes.length) return { error:'rates_gap_verification_source_mismatch' }
  const intervalMs = timeframeIntervalMs(timeframe)
  const spanSteps = (endUtcMs - startUtcMs) / intervalMs
  if (!Number.isInteger(spanSteps) || spanSteps < 1 || spanSteps > CACHE_LIMIT) {
    return { error:'rates_gap_verification_window_invalid' }
  }
  const theoreticalTimes = []
  for (let cursor = startUtcMs; cursor < endUtcMs; cursor += intervalMs) theoreticalTimes.push(cursor)
  const expectedMissing = new Set(expectedMissingTimes.map(Number).filter(Number.isFinite))
  const unexpectedMissingTimes = theoreticalTimes.filter(time => !bridgeTimes.has(time) && !expectedMissing.has(time))
  if (unexpectedMissingTimes.length) return { error:'rates_gap_verification_source_mismatch' }
  return { rates:inWindow, missing_times:theoreticalTimes.filter(time => !bridgeTimes.has(time)) }
}

/**
 * Verify cache-only gaps with the exact same Bridge source. A source that
 * returns the same missing opens is recorded as observed-only; a response
 * containing those opens repairs the cache. No broad count refill is used.
 */
async function verifyCachedGapsWithBridge(bridgeUserId, symbol, timeframe, gaps, clock, source,
  platformRoute = {}, observedRates = []) {
  const intervalMs = timeframeIntervalMs(timeframe)
  const validGaps = (Array.isArray(gaps) ? gaps : [])
    .filter(gap => expectedGapTimes(gap, intervalMs))
  if (validGaps.length !== (Array.isArray(gaps) ? gaps.length : 0)) {
    return { error:'rates_gap_verification_window_invalid' }
  }
  if (!validGaps.length) return { status:'none', rates:[], source_gaps:[], filled_gaps:[] }
  const identity = sourceIdentity(bridgeUserId, clock)
  if (!hasStableSourceIdentity(identity)
    || (source?.sourceKey && source.sourceKey !== identity.sourceKey)) {
    return { error:'rates_gap_verification_source_identity_changed' }
  }
  const standardSymbol = stripBrokerSuffix(symbol)
  // The two cached candles that bound the gap are sufficient to prove that
  // the terminal is answering for the same window. Extending one interval
  // before the left boundary can cross a separate market closure and turn a
  // valid source gap into a false "window incomplete" result.
  const startUtcMs = Math.min(...validGaps.map(gap => Number(gap.from_utc_msc)))
  const endUtcMs = Math.max(...validGaps.map(gap => Number(gap.to_utc_msc) + intervalMs))
  const count = Math.min(CACHE_LIMIT, Math.max(2, Math.ceil((endUtcMs - startUtcMs) / intervalMs) + 1))
  const expectedMissingTimes = [...new Set(validGaps.flatMap(gap => expectedGapTimes(gap, intervalMs) || []))]
  const expectedObservedTimes = [...new Set((Array.isArray(observedRates) ? observedRates : [])
    .map(rate => Number(rate?.time_utc_msc))
    .filter(time => Number.isFinite(time) && time >= startUtcMs && time < endUtcMs))]
  const keys = validGaps.map(gap => sourceGapKey(source?.id, identity.sourceKey, standardSymbol, timeframe, gap))
  const cachedResults = validGaps.map((gap, index) => getVerifiedSourceGap(keys[index]) ? gap : null).filter(Boolean)
  const pending = validGaps.filter((gap, index) => !getVerifiedSourceGap(keys[index]))
  if (!pending.length) return { status:'verified_source_gap', rates:[], source_gaps:cachedResults, filled_gaps:[] }

  const response = await mt5Bridge(bridgeUserId, 'rates', {
    symbol, timeframe, count, start_utc_msc:startUtcMs, end_utc_msc:endUtcMs, ...platformRoute,
  }, { timeoutMs:30000, noFallback:true })
  const effectiveClock = effectiveResponseClock(clock, response, response?.rates)
  const responseIdentity = sourceIdentity(bridgeUserId, effectiveClock)
  if (!hasStableSourceIdentity(responseIdentity) || responseIdentity.sourceKey !== identity.sourceKey) {
    return { error:'rates_gap_verification_source_identity_changed' }
  }
  const normalized = normalizeGapVerificationRates(response, effectiveClock, symbol, timeframe, startUtcMs, endUtcMs,
    expectedObservedTimes, expectedMissingTimes)
  if (normalized.error) return { error:normalized.error }
  const ratesByTime = new Map(normalized.rates.map(rate => [Number(rate.time_utc_msc), rate]))
  const sourceGaps = [...cachedResults]
  const filledGaps = []
  for (const gap of pending) {
    const expected = expectedGapTimes(gap, intervalMs)
    const missing = expected.filter(time => !ratesByTime.has(time))
    if (missing.length === expected.length) {
      sourceGaps.push(gap)
      rememberVerifiedSourceGap(sourceGapKey(source?.id, identity.sourceKey, standardSymbol, timeframe, gap), {
        verified_at:Date.now(), missing_times:missing,
      })
    } else if (missing.length === 0) {
      filledGaps.push(gap)
    } else {
      return { error:'rates_gap_verification_window_incomplete' }
    }
  }
  return { status:sourceGaps.length ? 'verified_source_gap' : 'filled', rates:normalized.rates,
    source_gaps:sourceGaps, filled_gaps:filledGaps, source_identity:responseIdentity,
    clock:effectiveClock, start_utc_msc:startUtcMs, end_utc_msc:endUtcMs }
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
        if (response.range_complete !== true) {
          return { status:'error', error:'rates_range_incomplete', message:'桥接未确认请求范围读取完成' }
        }
        const effectiveClock = effectiveResponseClock(clock, response, response.rates)
        const closureCutoffUtcMs = Math.min(rangeEndUtcMs, Math.floor(Date.now() / timeframeIntervalMs(timeframe)) * timeframeIntervalMs(timeframe))
        const intervalMs = timeframeIntervalMs(timeframe)
        const normalizedRates = response.rates.map(rate => validRate(rate, effectiveClock.timezone_offset_minutes))
        if (normalizedRates.some(rate => !rate)) {
          return { status:'error', error:'rates_timestamp_invalid', message:'桥接返回的 K 线时间无效' }
        }
        const normalizedTimesInOrder = normalizedRates.map(rate => Number(rate.time_utc_msc))
        if (new Set(normalizedTimesInOrder).size !== normalizedTimesInOrder.length) {
          return { status:'error', error:'rates_gap_verification_duplicate_open_time', message:'行情包含重复开盘时间' }
        }
        const closedRates = normalizedRates
          .filter(rate => rate.time_utc_msc >= rangeStartUtcMs
            && rate.time_utc_msc < rangeEndUtcMs
            && rate.time_utc_msc + intervalMs <= closureCutoffUtcMs)
        if (!closedRates.length) {
          return { status:'error', error:'rates_timestamp_invalid', message:'桥接返回的 K 线时间无效' }
        }
        const normalizedTimes = new Set(normalizedRates.map(rate => Number(rate.time_utc_msc)))
        if (!normalizedTimes.has(rangeStartUtcMs)) {
          return { status:'error', error:'rates_range_incomplete', message:'桥接返回的 K 线未覆盖请求范围起点' }
        }
        const brokerSymbol = response.symbol || symbol
        const ensured = await ensureSourceBestEffort(platformUserId, effectiveClock, response.rates.at(-1))
        const sourceId = ensured.sourceId
        const written = await writeClosedWindowBestEffort(sourceId, brokerSymbol, timeframe, closedRates)
        const writeFailures = [...ensured.failures, ...written.failures]
        const rangeIntegrity = inspectRateContinuity(closedRates, timeframe, {
          standardSymbol:stripBrokerSuffix(symbol), strictSessionPolicy:true, ignoreMarketSessionPolicy:true, env:{},
          platform:effectiveClock.platform,
          brokerServer:effectiveClock.broker_server,
          timezoneOffsetMinutes:effectiveClock.timezone_offset_minutes,
          sessionTimezone:effectiveClock.session_timezone || effectiveClock.timezone_name || effectiveClock.broker_timezone,
          clockStatus:effectiveClock.clock_status,
        })
        if (duplicateGapDetected(rangeIntegrity)) {
          return { status:'error', error:'rates_gap_verification_duplicate_open_time', message:'行情包含重复开盘时间' }
        }
        const rangeSourceGaps = timeGapDetails(rangeIntegrity)
        const rangeVerifiedIntegrity = {
          ...rangeIntegrity,
          status:'ok',
          continuity_status:rangeSourceGaps.length ? 'verified_source_gap' : 'verified_source_range',
          continuity_reason:rangeSourceGaps.length ? 'verified_source_gap' : 'verified_source_range',
          continuity_reasons:[...new Set([...(rangeIntegrity.continuity_reasons || []),
            rangeSourceGaps.length ? 'verified_source_gap' : 'verified_source_range'])],
          suspicious_gaps:[], uncovered_ranges:[], uncovered:[],
          audit_suspicious_gaps:[...(rangeIntegrity.audit_suspicious_gaps || []), ...rangeSourceGaps],
        }
        const rangeSourceIdentity = sourceIdentity(platformUserId, effectiveClock)
        for (const gap of rangeSourceGaps) {
          rememberVerifiedSourceGap(sourceGapKey(sourceId, rangeSourceIdentity.sourceKey,
            stripBrokerSuffix(symbol), timeframe, gap), { verified_at:Date.now(), missing_times:expectedGapTimes(gap, intervalMs) })
        }
        return { ...response, rates:closedRates, market_meta:{
          source:'platform_admin_bridge_range', source_user_id:platformUserId, source_id:sourceId,
          broker_symbol:brokerSymbol, timeframe, timezone_offset_minutes:effectiveClock.timezone_offset_minutes,
          platform:effectiveClock.platform || null,
          ...marketSourceIdentityMeta(platformUserId, effectiveClock),
          clock_status:effectiveClock.clock_status, closed_candles_persisted:closedRates.length,
          clock_sample_age_ms:effectiveClock.clock_sample_age_ms,
          closed_candles_written:written.persistedCount, cache_layer:'exact_range', live_candle_cached:false,
          cache_write_degraded:writeFailures.length > 0,
          cache_write_failure_layers:writeFailures,
          last_bar_closed:true,
          cache_internal_gap_detected:rangeSourceGaps.length > 0,
          cache_internal_gap_unresolved:false,
          cache_internal_gap_status:rangeSourceGaps.length ? 'verified_source_gap' : 'verified_source_range',
          cache_internal_gap_verified_source:true,
          cache_internal_gap_details:rangeSourceGaps.slice(0, 3),
          range_coverage_verified:true,
          range_bridge_authoritative:true,
          endpoint_coverage_verified:true,
          ...continuityMeta(rangeVerifiedIntegrity),
           continuity_calendar_version:MARKET_SESSION_CALENDAR_VERSION,
           expected_closures:rangeVerifiedIntegrity.expected_closures.slice(0, 8),
           continuity_status:rangeVerifiedIntegrity.continuity_status,
           continuity_reason:rangeVerifiedIntegrity.continuity_reason,
           continuity_reasons:rangeVerifiedIntegrity.continuity_reasons,
           unknown_session_gap_count:rangeVerifiedIntegrity.unknown_session_gap_count,
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
      const cachedIntegrity = inspectRateContinuity(cachedResult.rates, timeframe, {
        standardSymbol, strictSessionPolicy:true, ignoreMarketSessionPolicy:true, env:{}, timezoneOffsetMinutes:effectiveClock.timezone_offset_minutes,
        platform:effectiveClock.platform,
        brokerServer:effectiveClock.broker_server,
        sessionTimezone:effectiveClock.session_timezone || effectiveClock.timezone_name || effectiveClock.broker_timezone,
        clockStatus:effectiveClock.clock_status,
      })
      const effectiveIdentity = sourceIdentity(platformUserId, effectiveClock)
      let sourceIdentityChanged = Boolean(source.id && source.sourceKey && source.sourceKey !== effectiveIdentity.sourceKey)
      // A short probe may expose the cached boundary as its still-forming last
      // bar.  It is still authoritative overlap for continuity purposes; do
      // not force a broad refill merely because splitRatesByClosure classified
      // that boundary row as live.
      const probeRates = [...split.closedRates, ...split.liveRates]
      const boundaryGapDetected = probeOnly && !ratesJoinAtCacheBoundary(cachedResult.rates, probeRates)
      const initialFreshIntegrity = inspectRateContinuity(closedRates, timeframe, {
        standardSymbol, strictSessionPolicy:true, ignoreMarketSessionPolicy:true, env:{}, timezoneOffsetMinutes:effectiveClock.timezone_offset_minutes,
        platform:effectiveClock.platform,
        brokerServer:effectiveClock.broker_server,
        sessionTimezone:effectiveClock.session_timezone || effectiveClock.timezone_name || effectiveClock.broker_timezone,
        clockStatus:effectiveClock.clock_status,
      })
      if (duplicateGapDetected(cachedIntegrity) || duplicateGapDetected(initialFreshIntegrity)) {
        return { status:'error', error:'rates_gap_verification_duplicate_open_time', message:'行情包含重复开盘时间' }
      }
      const cacheTimeGaps = timeGapDetails(cachedIntegrity)
      const freshTimeGaps = timeGapDetails(initialFreshIntegrity)
      const gapsToVerify = boundaryGapDetected ? [] : [...new Map([...cacheTimeGaps, ...freshTimeGaps]
        .map(gap => [`${gap.from_utc_msc}:${gap.to_utc_msc}`, gap])).values()]
      if (sourceIdentityChanged && gapsToVerify.length) {
        return { status:'error', error:'rates_gap_verification_source_identity_changed', message:'行情来源身份已变化，缓存缺口无法核验' }
      }
      let gapVerification = { status:'none', rates:[], source_gaps:[], filled_gaps:[] }
      if (gapsToVerify.length) {
        gapVerification = await verifyCachedGapsWithBridge(platformUserId, symbol, timeframe,
          gapsToVerify, effectiveClock, source, platformRoute,
          [...cachedResult.rates, ...closedRates])
        if (gapVerification.error) {
          return { status:'error', error:gapVerification.error, message:'Bridge 未能覆盖并核验缓存缺口' }
        }
        if (gapVerification.clock) {
          effectiveClock = gapVerification.clock
          const verificationIdentity = sourceIdentity(platformUserId, effectiveClock)
          sourceIdentityChanged = Boolean(source.id && source.sourceKey
            && source.sourceKey !== verificationIdentity.sourceKey)
        }
      }
      // A missing cache boundary cannot be safely inferred from a short probe.
      // Only the exact gap verifier may repair a known internal hole.
      const windowRefillNeeded = sourceIdentityChanged || boundaryGapDetected
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
      const freshIntegrity = inspectRateContinuity(closedRates, timeframe, {
        standardSymbol, strictSessionPolicy:true, ignoreMarketSessionPolicy:true, env:{}, timezoneOffsetMinutes:effectiveClock.timezone_offset_minutes,
        platform:effectiveClock.platform,
        brokerServer:effectiveClock.broker_server,
        sessionTimezone:effectiveClock.session_timezone || effectiveClock.timezone_name || effectiveClock.broker_timezone,
        clockStatus:effectiveClock.clock_status,
      })
      if (duplicateGapDetected(freshIntegrity)) {
        return { status:'error', error:'rates_gap_verification_duplicate_open_time', message:'行情包含重复开盘时间' }
      }
      const verifiedGapKeys = new Set([...gapVerification.source_gaps, ...gapVerification.filled_gaps]
        .map(gap => `${gap.from_utc_msc}:${gap.to_utc_msc}`))
      const postRefillGaps = timeGapDetails(freshIntegrity)
        .filter(gap => !verifiedGapKeys.has(`${gap.from_utc_msc}:${gap.to_utc_msc}`))
      if (postRefillGaps.length) {
        if (sourceIdentityChanged) {
          return { status:'error', error:'rates_gap_verification_source_identity_changed', message:'行情来源身份已变化，缓存缺口无法核验' }
        }
        const postVerification = await verifyCachedGapsWithBridge(platformUserId, symbol, timeframe,
          postRefillGaps, effectiveClock, source, platformRoute, [...cachedResult.rates, ...closedRates])
        if (postVerification.error) {
          return { status:'error', error:postVerification.error, message:'Bridge 未能覆盖并核验缓存缺口' }
        }
        gapVerification = {
          ...gapVerification,
          rates:mergeRates(gapVerification.rates || [], postVerification.rates || [], CACHE_LIMIT),
          source_gaps:[...(gapVerification.source_gaps || []), ...(postVerification.source_gaps || [])],
          filled_gaps:[...(gapVerification.filled_gaps || []), ...(postVerification.filled_gaps || [])],
        }
      }
      const brokerSymbol = response.symbol || symbol
      const verificationRates = Array.isArray(gapVerification.rates) ? gapVerification.rates : []
      const stored = mergeRates(windowRefillNeeded ? [] : cachedResult.rates,
        [...verificationRates, ...closedRates], CACHE_LIMIT)
      const storedIntegrity = inspectRateContinuity(stored, timeframe, {
        standardSymbol, strictSessionPolicy:true, ignoreMarketSessionPolicy:true, env:{}, timezoneOffsetMinutes:effectiveClock.timezone_offset_minutes,
        platform:effectiveClock.platform,
        brokerServer:effectiveClock.broker_server,
        sessionTimezone:effectiveClock.session_timezone || effectiveClock.timezone_name || effectiveClock.broker_timezone,
        clockStatus:effectiveClock.clock_status,
      })
      const verifiedSourceGap = gapVerification.source_gaps.length > 0
      const internalGapDetected = gapsToVerify.length > 0
      const internalGapUnresolved = false
      const gapDetails = gapVerification.source_gaps.length
        ? gapVerification.source_gaps : [...gapVerification.filled_gaps]
      const continuityIntegrity = verifiedSourceGap ? {
        ...storedIntegrity,
        status:'ok',
        continuity_status:'verified_source_gap',
        continuity_reason:'verified_source_gap',
        continuity_reasons:[...new Set([...(storedIntegrity.continuity_reasons || []), 'verified_source_gap'])],
        suspicious_gaps:[],
        uncovered_ranges:[], uncovered:[],
        audit_suspicious_gaps:[...(storedIntegrity.audit_suspicious_gaps || []), ...gapDetails],
      } : storedIntegrity
      const ensured = await ensureSourceBestEffort(platformUserId, effectiveClock, rates.at(-1))
      const sourceId = ensured.sourceId
      const finalSourceIdentityChanged = Boolean(sourceId)
        && (sourceIdentityChanged || Number(source.id) !== Number(sourceId))
      const effectiveStructureAnchor = finalSourceIdentityChanged
        ? await loadChanStructureAnchor(sourceId, standardSymbol, timeframe)
        : structureAnchor
      const written = await writeClosedWindowBestEffort(sourceId, brokerSymbol, timeframe,
        mergeRates(verificationRates, closedRates, CACHE_LIMIT), stored)
      const writeFailures = [...ensured.failures, ...written.failures]
      return {
        ...response,
        rates: mergeRates(stored, split.liveRates, count),
        market_meta: {
          source: 'platform_admin_bridge', source_user_id: platformUserId,
          source_id: sourceId, broker_symbol: brokerSymbol, timeframe,
          platform: effectiveClock.platform || null,
          ...marketSourceIdentityMeta(platformUserId, effectiveClock),
          timezone_offset_minutes: effectiveClock.timezone_offset_minutes,
          clock_status: effectiveClock.clock_status,
          clock_sample_age_ms:effectiveClock.clock_sample_age_ms,
          closed_candles_persisted: stored.length,
          closed_candles_written: written.persistedCount,
          cache_layer: sourceIdentityChanged ? 'cold' : cachedResult.layer,
          cache_write_degraded: writeFailures.length > 0,
          cache_write_failure_layers: writeFailures,
          cache_gap_refilled: windowRefillNeeded || gapVerification.filled_gaps.length > 0,
          cache_gap_verified: gapsToVerify.length > 0,
          cache_internal_gap_status:verifiedSourceGap ? 'verified_source_gap' : (gapsToVerify.length ? 'filled' : null),
          cache_internal_gap_verified_source:verifiedSourceGap,
          cache_source_identity_refilled: sourceIdentityChanged,
          cache_boundary_gap_refilled: boundaryGapDetected,
          cache_internal_gap_detected: internalGapDetected,
          cache_internal_gap_refill_attempted: false,
          cache_internal_gap_unresolved: internalGapUnresolved,
          cache_internal_gap_details:gapDetails.slice(0, 3),
          ...continuityMeta(continuityIntegrity),
           continuity_calendar_version:MARKET_SESSION_CALENDAR_VERSION,
           expected_closures:continuityIntegrity.expected_closures.slice(0, 8),
           continuity_status:continuityIntegrity.continuity_status,
           continuity_reason:continuityIntegrity.continuity_reason,
           continuity_reasons:continuityIntegrity.continuity_reasons,
           unknown_session_gap_count:continuityIntegrity.unknown_session_gap_count,
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
  if (fallbackReviewRange && fallback.range_complete !== true) {
    return { status:'error', error:'rates_range_incomplete', message:'桥接未确认请求范围读取完成' }
  }

  let effectiveFallbackClock = effectiveResponseClock(fallbackClock, fallback, fallback.rates)
  let fallbackOffset = effectiveFallbackClock.timezone_offset_minutes ?? null
  let fallbackSplit = splitRatesByClosure(fallback.rates, timeframe, fallbackOffset)
  if (fallbackReviewRange) {
    const intervalMs = timeframeIntervalMs(timeframe)
    const closureCutoffUtcMs = Math.min(fallbackRangeEnd, Math.floor(Date.now() / timeframeIntervalMs(timeframe)) * timeframeIntervalMs(timeframe))
    const normalizedFallbackRates = fallback.rates.map(rate => validRate(rate, fallbackOffset))
    if (normalizedFallbackRates.some(rate => !rate)) {
      return { status:'error', error:'rates_timestamp_invalid', message:'桥接返回的 K 线时间无效' }
    }
    const normalizedFallbackTimes = normalizedFallbackRates.map(rate => Number(rate.time_utc_msc))
    if (new Set(normalizedFallbackTimes).size !== normalizedFallbackTimes.length) {
      return { status:'error', error:'rates_gap_verification_duplicate_open_time', message:'行情包含重复开盘时间' }
    }
    const closedRates = normalizedFallbackRates
      .filter(rate => rate.time_utc_msc >= fallbackRangeStart && rate.time_utc_msc < fallbackRangeEnd
        && rate.time_utc_msc + intervalMs <= closureCutoffUtcMs)
    fallbackSplit = { closedRates, liveRates:[], lastBarClosed:true }
  }
  if (!fallbackSplit.closedRates.length && !fallbackSplit.liveRates.length) {
    return { status:'error', error:'rates_timestamp_invalid', message:'桥接返回的 K 线时间无效' }
  }
  if (fallbackReviewRange && !fallback.rates.some(rate => Number(validRate(rate, fallbackOffset)?.time_utc_msc) === fallbackRangeStart)) {
    return { status:'error', error:'rates_range_incomplete', message:'桥接返回的 K 线未覆盖请求范围起点' }
  }
  const initialFallbackIdentity = sourceIdentity(requestUserId, effectiveFallbackClock)
  let fallbackIdentityChanged = Boolean(existingFallbackSource.id && existingFallbackSource.sourceKey
    && existingFallbackSource.sourceKey !== initialFallbackIdentity.sourceKey)
  const fallbackCachedIntegrity = inspectRateContinuity(fallbackCached.rates, timeframe, {
    standardSymbol:fallbackStandardSymbol, strictSessionPolicy:true, ignoreMarketSessionPolicy:true, env:{}, timezoneOffsetMinutes:fallbackOffset,
    platform:effectiveFallbackClock.platform,
    brokerServer:effectiveFallbackClock.broker_server,
    sessionTimezone:effectiveFallbackClock.session_timezone || effectiveFallbackClock.timezone_name || effectiveFallbackClock.broker_timezone,
    clockStatus:effectiveFallbackClock.clock_status,
  })
  const fallbackProbeRates = [...fallbackSplit.closedRates, ...fallbackSplit.liveRates]
  const fallbackBoundaryGap = fallbackProbeOnly && !ratesJoinAtCacheBoundary(fallbackCached.rates, fallbackProbeRates)
  const fallbackInitialIntegrity = inspectRateContinuity(fallbackSplit.closedRates, timeframe, {
    standardSymbol:fallbackStandardSymbol, strictSessionPolicy:true, ignoreMarketSessionPolicy:true, env:{}, timezoneOffsetMinutes:fallbackOffset,
    platform:effectiveFallbackClock.platform,
    brokerServer:effectiveFallbackClock.broker_server,
    sessionTimezone:effectiveFallbackClock.session_timezone || effectiveFallbackClock.timezone_name || effectiveFallbackClock.broker_timezone,
    clockStatus:effectiveFallbackClock.clock_status,
  })
  if (duplicateGapDetected(fallbackCachedIntegrity) || duplicateGapDetected(fallbackInitialIntegrity)) {
    return { status:'error', error:'rates_gap_verification_duplicate_open_time', message:'行情包含重复开盘时间' }
  }
  const fallbackGaps = [...new Map([...timeGapDetails(fallbackCachedIntegrity), ...timeGapDetails(fallbackInitialIntegrity)]
    .map(gap => [`${gap.from_utc_msc}:${gap.to_utc_msc}`, gap])).values()]
  if (fallbackIdentityChanged && fallbackGaps.length) {
    return { status:'error', error:'rates_gap_verification_source_identity_changed', message:'行情来源身份已变化，缓存缺口无法核验' }
  }
  let fallbackGapVerification = { status:'none', rates:[], source_gaps:[], filled_gaps:[] }
  if (fallbackGaps.length) {
    fallbackGapVerification = await verifyCachedGapsWithBridge(requestUserId, symbol, timeframe,
      fallbackGaps, effectiveFallbackClock, existingFallbackSource, {},
      [...fallbackCached.rates, ...fallbackSplit.closedRates])
    if (fallbackGapVerification.error) {
      return { status:'error', error:fallbackGapVerification.error, message:'Bridge 未能覆盖并核验缓存缺口' }
    }
    if (fallbackGapVerification.clock) {
      effectiveFallbackClock = fallbackGapVerification.clock
      fallbackOffset = effectiveFallbackClock.timezone_offset_minutes ?? null
      const verificationIdentity = sourceIdentity(requestUserId, effectiveFallbackClock)
      fallbackIdentityChanged = Boolean(existingFallbackSource.id && existingFallbackSource.sourceKey
        && existingFallbackSource.sourceKey !== verificationIdentity.sourceKey)
    }
  }
  const fallbackRefillNeeded = !fallbackReviewRange
    && (fallbackIdentityChanged || fallbackBoundaryGap)
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
  const fallbackIntegrity = inspectRateContinuity(fallbackSplit.closedRates, timeframe, {
    standardSymbol:fallbackStandardSymbol, strictSessionPolicy:true, ignoreMarketSessionPolicy:true, env:{}, timezoneOffsetMinutes:fallbackOffset,
    platform:effectiveFallbackClock.platform,
    brokerServer:effectiveFallbackClock.broker_server,
    sessionTimezone:effectiveFallbackClock.session_timezone || effectiveFallbackClock.timezone_name || effectiveFallbackClock.broker_timezone,
    clockStatus:effectiveFallbackClock.clock_status,
  })
  if (duplicateGapDetected(fallbackIntegrity)) {
    return { status:'error', error:'rates_gap_verification_duplicate_open_time', message:'行情包含重复开盘时间' }
  }
  const fallbackVerifiedGapKeys = new Set([...(fallbackGapVerification.source_gaps || []), ...(fallbackGapVerification.filled_gaps || [])]
    .map(gap => `${gap.from_utc_msc}:${gap.to_utc_msc}`))
  const fallbackPostRefillGaps = timeGapDetails(fallbackIntegrity)
    .filter(gap => !fallbackVerifiedGapKeys.has(`${gap.from_utc_msc}:${gap.to_utc_msc}`))
  if (fallbackPostRefillGaps.length) {
    if (fallbackIdentityChanged) {
      return { status:'error', error:'rates_gap_verification_source_identity_changed', message:'行情来源身份已变化，缓存缺口无法核验' }
    }
    const postVerification = await verifyCachedGapsWithBridge(requestUserId, symbol, timeframe,
      fallbackPostRefillGaps, effectiveFallbackClock, existingFallbackSource, {},
      [...fallbackCached.rates, ...fallbackSplit.closedRates])
    if (postVerification.error) {
      return { status:'error', error:postVerification.error, message:'Bridge 未能覆盖并核验缓存缺口' }
    }
    fallbackGapVerification = {
      ...fallbackGapVerification,
      rates:mergeRates(fallbackGapVerification.rates || [], postVerification.rates || [], CACHE_LIMIT),
      source_gaps:[...(fallbackGapVerification.source_gaps || []), ...(postVerification.source_gaps || [])],
      filled_gaps:[...(fallbackGapVerification.filled_gaps || []), ...(postVerification.filled_gaps || [])],
    }
  }
  const fallbackBrokerSymbol = fallback.symbol || symbol
  const ensuredFallback = await ensureSourceBestEffort(requestUserId, effectiveFallbackClock, fallback.rates.at(-1))
  const fallbackSourceId = ensuredFallback.sourceId
  const fallbackVerificationRates = Array.isArray(fallbackGapVerification.rates) ? fallbackGapVerification.rates : []
  const fallbackStored = fallbackReviewRange
    ? fallbackSplit.closedRates
    : mergeRates(fallbackRefillNeeded ? [] : fallbackCached.rates,
      [...fallbackVerificationRates, ...fallbackSplit.closedRates], CACHE_LIMIT)
  const fallbackStoredIntegrity = inspectRateContinuity(fallbackStored, timeframe, {
    standardSymbol:fallbackStandardSymbol, strictSessionPolicy:true, ignoreMarketSessionPolicy:true, env:{}, timezoneOffsetMinutes:fallbackOffset,
    platform:effectiveFallbackClock.platform,
    brokerServer:effectiveFallbackClock.broker_server,
    sessionTimezone:effectiveFallbackClock.session_timezone || effectiveFallbackClock.timezone_name || effectiveFallbackClock.broker_timezone,
    clockStatus:effectiveFallbackClock.clock_status,
  })
  const fallbackRangeSourceGaps = fallbackReviewRange ? timeGapDetails(fallbackStoredIntegrity) : []
  const fallbackVerifiedSourceGap = fallbackGapVerification.source_gaps.length > 0
    || fallbackRangeSourceGaps.length > 0
  const fallbackGapDetails = fallbackGapVerification.source_gaps.length
    ? fallbackGapVerification.source_gaps
    : fallbackRangeSourceGaps.length ? fallbackRangeSourceGaps : fallbackGapVerification.filled_gaps
  const fallbackContinuityIntegrity = fallbackVerifiedSourceGap ? {
    ...fallbackStoredIntegrity,
    status:'ok', continuity_status:'verified_source_gap', continuity_reason:'verified_source_gap',
    continuity_reasons:[...new Set([...(fallbackStoredIntegrity.continuity_reasons || []), 'verified_source_gap'])],
    suspicious_gaps:[], uncovered_ranges:[], uncovered:[],
    audit_suspicious_gaps:[...(fallbackStoredIntegrity.audit_suspicious_gaps || []), ...fallbackGapDetails],
  } : fallbackStoredIntegrity
  const writtenFallback = await writeClosedWindowBestEffort(fallbackSourceId, fallbackBrokerSymbol, timeframe,
    mergeRates(fallbackVerificationRates, fallbackSplit.closedRates, CACHE_LIMIT), fallbackReviewRange ? null : fallbackStored)
  const fallbackWriteFailures = [...ensuredFallback.failures, ...writtenFallback.failures]
  const resolvedFallbackStandardSymbol = stripBrokerSuffix(fallbackBrokerSymbol)
  const fallbackStructureAnchor = await loadChanStructureAnchor(
    fallbackSourceId, resolvedFallbackStandardSymbol, timeframe)
  fallback.rates = mergeRates(fallbackStored, fallbackSplit.liveRates, count)
  fallback.market_meta = {
    source:'user_bridge_fallback', source_user_id:requestUserId, broker_symbol:fallbackBrokerSymbol,
    source_id:fallbackSourceId, platform:effectiveFallbackClock.platform || null,
    ...marketSourceIdentityMeta(requestUserId, effectiveFallbackClock),
    timeframe, timezone_offset_minutes:fallbackOffset,
    clock_status:effectiveFallbackClock.clock_status || 'unknown',
    clock_sample_age_ms:effectiveFallbackClock.clock_sample_age_ms,
    closed_candles_persisted:fallbackStored.length,
    closed_candles_written:writtenFallback.persistedCount,
    cache_layer:fallbackIdentityChanged ? 'cold' : fallbackCached.layer,
    cache_write_degraded:fallbackWriteFailures.length > 0,
    cache_write_failure_layers:fallbackWriteFailures,
    cache_gap_refilled:fallbackRefillNeeded || fallbackGapVerification.filled_gaps.length > 0,
    cache_gap_verified:fallbackGaps.length > 0,
    cache_internal_gap_status:fallbackVerifiedSourceGap ? 'verified_source_gap' : (fallbackGaps.length ? 'filled' : null),
    cache_internal_gap_verified_source:fallbackVerifiedSourceGap,
    cache_source_identity_refilled:fallbackIdentityChanged,
    cache_boundary_gap_refilled:fallbackBoundaryGap,
    cache_internal_gap_refill_attempted:false,
    live_candle_cached:false,
    last_bar_closed:fallbackSplit.lastBarClosed,
    cache_internal_gap_detected:fallbackGaps.length > 0,
    cache_internal_gap_unresolved:false,
    cache_internal_gap_details:fallbackGapDetails.slice(0, 3),
    ...continuityMeta(fallbackContinuityIntegrity),
    continuity_calendar_version:MARKET_SESSION_CALENDAR_VERSION,
    expected_closures:fallbackContinuityIntegrity.expected_closures.slice(0, 8),
    continuity_status:fallbackContinuityIntegrity.continuity_status,
    continuity_reason:fallbackContinuityIntegrity.continuity_reason,
    continuity_reasons:fallbackContinuityIntegrity.continuity_reasons,
    unknown_session_gap_count:fallbackContinuityIntegrity.unknown_session_gap_count,
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
