import { queryAll, queryOne } from '../../db.js'
import { calculateMarketData, platformRates } from './market-data.js'
import { stripBrokerSuffix } from './utils.js'
import { sha256 } from './inference-snapshots.js'
import { resolveFrozenChanRequirement } from './inference-snapshots.js'
import { getChanWindowPolicy, CHAN_WINDOW_POLICY_VERSION } from './chan-window-policy.js'
import { classifyContinuityGap, MARKET_SESSION_CALENDAR_VERSION } from './market-session-calendar.js'
import { resolveMarketSessionPolicy } from './market-session-policy.js'

export const REVIEW_TIMEFRAME_MS = { M1:60000, M5:300000, M15:900000, M30:1800000, H1:3600000, H4:14400000, D1:86400000 }
// K-lines are shared market evidence.  The source identity is retained for
// provenance, but platform reviews must select one quality-checked source per
// symbol/timeframe/window instead of requiring the observer account identity.
export const PERIOD_MARKET_SOURCE_POLICY_VERSION = 'shared-canonical-v1'
const TRUSTED_MARKET_CLOCK_STATUSES = ['verified', 'calibrated', 'observer_bootstrap', 'mt4_current_offset']
const MAX_REVIEW_WINDOW_CANDLES = 5000
// Ordinary indicator/context warmup. Chan history is always supplied through
// its frozen v6 window policy and never falls back to this value.
const REVIEW_CONTEXT_LOOKBACK_BARS = 200
const DAILY_MAINTENANCE_TOLERANCE_MS = 2 * 3600000

const parse = (value, fallback = null) => { try { return value == null ? fallback : JSON.parse(value) } catch { return fallback } }
const compactRate = rate => ({ t:Number(rate.time_utc_msc), bt:rate.broker_time || rate.time || null,
  o:Number(rate.open), h:Number(rate.high), l:Number(rate.low), c:Number(rate.close), v:Number(rate.tick_volume || 0) })

function sourceIdentityFromRow(row = {}) {
  const sourceKey = String(row.source_key || '').trim() || null
  const keyParts = sourceKey ? sourceKey.split('|') : []
  return {
    source_id:Number(row.id || row.source_id) || null,
    source_key:sourceKey,
    platform:String(row.platform || keyParts[0] || '').trim().toLowerCase() || null,
    broker_server:row.broker_server || null,
    account_login:row.account_login == null ? null : String(row.account_login),
  }
}

function frozenSourceIdentities(sources = []) {
  const result = []
  const seen = new Set()
  const visit = value => {
    if (!value || typeof value !== 'object') return
    const referenceIdentities = [value?.source_identity, ...(Array.isArray(value?.source_identities) ? value.source_identities : [])]
    for (const identity of referenceIdentities) {
      if (!identity || typeof identity !== 'object') continue
      const normalized = sourceIdentityFromRow(identity)
      if (!normalized.source_id && !normalized.source_key) continue
      const identityKey = normalized.source_key || `id:${normalized.source_id}`
      if (!seen.has(identityKey)) { seen.add(identityKey); result.push(normalized) }
    }
    const frames = value?.market_snapshot?.strategy_context?.timeframes
      || value?.marketSnapshot?.strategy_context?.timeframes
      || value?.strategy_context?.timeframes
      || null
    for (const frame of Object.values(frames || {})) {
      const quality = frame?.summary?.market_data_quality || frame?.market_data_quality || {}
      const identity = sourceIdentityFromRow(quality)
      if (!identity.source_id && !identity.source_key) continue
      const key = identity.source_key || `id:${identity.source_id}`
      if (!seen.has(key)) { seen.add(key); result.push(identity) }
    }
    for (const child of [value?.inference_time?.snapshot, value?.inference_time?.snapshot_ref,
      value?.snapshot, value?.snapshot_ref, value?.evidence]) visit(child)
  }
  for (const source of sources || []) visit(source)
  return result
}

function continuityPolicyFields(result = {}, options = {}) {
  const pick = (...values) => values.find(value => value !== undefined && value !== null && value !== '') ?? null
  const policy = result.policy && typeof result.policy === 'object' ? result.policy : {}
  return {
    continuity_engine_version:pick(result.continuity_engine_version, result.engine_version,
      options.continuityEngineVersion, options.continuity_engine_version),
    continuity_policy_id:pick(result.continuity_policy_id, result.policy_id,
      policy.policy_id, options.continuityPolicyId, options.continuity_policy_id),
    continuity_policy_version:pick(result.continuity_policy_version, result.policy_version,
      policy.policy_version, policy.version, options.continuityPolicyVersion, options.continuity_policy_version),
    continuity_policy_hash:pick(result.continuity_policy_hash, result.policy_hash,
      policy.policy_hash, options.continuityPolicyHash, options.continuity_policy_hash),
    continuity_policy_match:pick(result.continuity_policy_match, result.policy_match,
      options.continuityPolicyMatch, options.continuity_policy_match),
    continuity_policy_mode:pick(result.continuity_policy_mode, result.policy_mode, policy.mode,
      options.marketSessionPolicyMode, options.market_session_policy_mode),
  }
}

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
    .map(row => ({ time:Number(row?.time_utc_msc), broker_time:row?.broker_time || row?.time || null }))
    .filter(row => Number.isFinite(row.time))
    .filter(row => row.time >= Number(startUtcMs) && row.time < Number(endUtcMs))
    .sort((a, b) => a.time - b.time)
    .filter((row, index, values) => index === 0 || row.time !== values[index - 1].time)
  if (!interval || !sorted.length) return { complete:false, endpoint_complete:false, internal_gap_count:0, max_gap_ms:0,
    continuity_status:'unavailable', continuity_reason:'period_market_candles_missing', continuity_reasons:['period_market_candles_missing'] }
  const strictSessionPolicy = options.strictSessionPolicy === true
  const ignoreSessionPolicy = options.ignoreMarketSessionPolicy === true
  const verifiedSourceGap = options.verifiedSourceGap === true
    || options.rangeBridgeAuthoritative === true
    || options.range_bridge_authoritative === true
    || String(options.cache_internal_gap_status || options.continuity_status || '').toLowerCase() === 'verified_source_gap'
  const standardSymbol = stripBrokerSuffix(options.standardSymbol || options.symbol || '')
  const continuityReasons = new Set()
  const expectedClosures = []
  const suspiciousGaps = []
  const continuityResults = []
  const auditExpectedClosures = []
  const auditSuspiciousGaps = []
  const policyMatch = ignoreSessionPolicy ? { mode:'off', matched:false } : resolveMarketSessionPolicy({
    platform:options.platform,
    broker_server:options.brokerServer || options.broker_server,
    standard_symbol:standardSymbol,
  }, { env:options.env || process.env })
  const policyFields = { ...continuityPolicyFields({ policy:{
    mode:policyMatch.mode,
    matched:policyMatch.matched,
    policy_id:policyMatch.policy_id,
    policy_version:policyMatch.policy_version,
    policy_hash:policyMatch.policy_hash,
  }, policy_match:policyMatch.matched }, options), continuity_calendar_version:options.calendarVersion
    || options.continuityCalendarVersion || options.continuity_calendar_version || MARKET_SESSION_CALENDAR_VERSION }
  let unknownSessionGapCount = 0
  const maybeDailyPolicyGap = (from, to) => {
    const gap = Number(to) - Number(from)
    return strictSessionPolicy && gap > Math.max(interval, 30 * 60 * 1000)
      && gap <= DAILY_MAINTENANCE_TOLERANCE_MS
  }
  const closure = (from, to, fromBrokerTime = null, toBrokerTime = null) => ignoreSessionPolicy ? null : classifyContinuityGap(from, to, timeframe, {
    intervalMs:interval, standardSymbol, strictSessionPolicy,
    timezoneOffsetMinutes:options.timezoneOffsetMinutes ?? options.timezone_offset_minutes,
    sessionTimezone:options.sessionTimezone || options.session_timezone,
    clockStatus:options.clockStatus || options.clock_status,
    policyVersion:options.policyVersion || options.marketSessionPolicyVersion || MARKET_SESSION_CALENDAR_VERSION,
    sourceId:options.sourceId || options.source_id || null,
    sourceKey:options.sourceKey || options.source_key || null,
    platform:options.platform || null,
    brokerServer:options.brokerServer || options.broker_server || null,
    accountLogin:options.accountLogin || options.account_login || null,
    fromBrokerTime, toBrokerTime, start_broker_time:fromBrokerTime, end_broker_time:toBrokerTime,
    marketSessionPolicyMode:options.marketSessionPolicyMode || options.market_session_policy_mode || options.continuity_policy_mode,
    env:options.env,
  })
  const recordClosure = (from, to, fromBrokerTime = null, toBrokerTime = null) => {
    const result = closure(from, to, fromBrokerTime, toBrokerTime)
    Object.assign(policyFields, continuityPolicyFields(result || {}, options))
    if (result?.calendar_version) policyFields.continuity_calendar_version = result.calendar_version
    if (result) continuityResults.push({ from_utc_msc:from, to_utc_msc:to, ...result })
    const effectiveResult = result?.audit_only === true
      ? classifyContinuityGap(from, to, timeframe, {
        intervalMs:interval, standardSymbol, strictSessionPolicy,
        timezoneOffsetMinutes:options.timezoneOffsetMinutes ?? options.timezone_offset_minutes,
        sessionTimezone:options.sessionTimezone || options.session_timezone,
        clockStatus:options.clockStatus || options.clock_status,
        policyVersion:options.policyVersion || options.marketSessionPolicyVersion || MARKET_SESSION_CALENDAR_VERSION,
        sourceId:options.sourceId || options.source_id || null,
        sourceKey:options.sourceKey || options.source_key || null,
        platform:options.platform || null,
        brokerServer:options.brokerServer || options.broker_server || null,
        accountLogin:options.accountLogin || options.account_login || null,
        startBrokerTime:fromBrokerTime, endBrokerTime:toBrokerTime,
        marketSessionPolicyMode:'off', env:options.env,
      })
      : result
    const detail = { from_utc_msc:from, to_utc_msc:to, gap_ms:to - from,
      missing_bar_count:Math.max(1, Math.round((to - from) / interval) - 1) }
    if (result?.audit_only === true) {
      const collection = result?.known === true && result?.expected !== false
        ? auditExpectedClosures : auditSuspiciousGaps
      collection.push({ ...detail, ...result })
    }
    if (effectiveResult?.known === true && effectiveResult?.expected !== false) {
      expectedClosures.push({ ...detail, ...effectiveResult })
    }
    if (effectiveResult?.classification === 'unknown_session' || effectiveResult?.known === false) {
      unknownSessionGapCount += 1
      continuityReasons.add(effectiveResult.reason || 'market_session_policy_unavailable')
    } else if (effectiveResult?.expected === false || effectiveResult?.classification === 'suspicious_gap') {
      continuityReasons.add(effectiveResult.reason || 'market_open_bars_missing')
    } else if (!effectiveResult) {
      continuityReasons.add(maybeDailyPolicyGap(from, to)
        ? 'daily_session_policy_missing' : 'market_open_bars_missing')
    }
    return { policyResult:result, effectiveResult }
  }
  const closureComplete = (from, to, fromBrokerTime = null, toBrokerTime = null) =>
    recordClosure(from, to, fromBrokerTime, toBrokerTime)?.effectiveResult?.known === true
  // Historical ranges are hydrated directly from MT5 before this check. In
  // strict mode only an explicitly known closure can cover an endpoint gap.
  const startTolerance = Math.max(interval, DAILY_MAINTENANCE_TOLERANCE_MS)
  const endTolerance = Math.max(interval * 2, DAILY_MAINTENANCE_TOLERANCE_MS)
  const rangeBridgeAuthoritative = options.rangeBridgeAuthoritative === true || options.range_bridge_authoritative === true
  const startCovered = verifiedSourceGap ? true : strictSessionPolicy
    ? sorted[0].time <= Number(startUtcMs) || closureComplete(Number(startUtcMs) - interval, sorted[0].time,
      null, sorted[0].broker_time)
    : sorted[0].time <= Number(startUtcMs) + startTolerance || crossesWeekend(Number(startUtcMs), sorted[0].time)
  const endCovered = verifiedSourceGap ? true : strictSessionPolicy
    ? sorted.at(-1).time + interval >= Number(endUtcMs) || closureComplete(sorted.at(-1).time, Number(endUtcMs),
      sorted.at(-1).broker_time, null)
    : sorted.at(-1).time >= Number(endUtcMs) - endTolerance || crossesWeekend(sorted.at(-1).time, Number(endUtcMs))
  const endpointComplete = startCovered && endCovered
  // 黄金、外汇每天可能存在短暂维护休市。只把超过两小时且不跨周末的缺口视为异常，
  // 避免将正常休市误判成缓存损坏，同时仍能识别桥接长时间断开造成的大段缺失。
  const toleratedGap = Math.max(interval * 3, 2 * 3600000)
  let internalGapCount = 0
  let maxGapMs = 0
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]
    const current = sorted[index]
    const gap = current.time - previous.time
    const closureResult = gap > interval ? recordClosure(previous.time, current.time, previous.broker_time, current.broker_time) : null
    const effectiveClosure = closureResult?.effectiveResult
    const knownClosure = gap > interval && effectiveClosure?.known === true && effectiveClosure?.expected !== false
    const tolerated = verifiedSourceGap || (ignoreSessionPolicy ? false
      : (strictSessionPolicy ? knownClosure : gap <= toleratedGap || crossesWeekend(previous.time, current.time)))
    if (gap > interval && !tolerated) {
      internalGapCount += 1
      maxGapMs = Math.max(maxGapMs, gap)
      suspiciousGaps.push({ from_utc_msc:previous.time, to_utc_msc:current.time, gap_ms:gap,
        missing_bar_count:Math.max(1, Math.round(gap / interval) - 1),
        ...(effectiveClosure?.reason ? { reason:effectiveClosure.reason } : {}) })
    }
  }
  const continuityStatus = rangeBridgeAuthoritative
    ? 'verified_source_range'
    : verifiedSourceGap
      ? 'verified_source_gap'
    : unknownSessionGapCount > 0
    ? 'unknown_session'
    : suspiciousGaps.length > 0 ? 'suspicious_gap'
      : continuityReasons.size > 0 ? 'policy_missing' : 'reliable'
  return { complete:endpointComplete && internalGapCount === 0, endpoint_complete:endpointComplete, internal_gap_count:internalGapCount,
    max_gap_ms:maxGapMs, continuity_status:continuityStatus,
    continuity_reason:rangeBridgeAuthoritative ? 'verified_source_range'
      : verifiedSourceGap ? 'verified_source_gap' : ([...continuityReasons][0] || null),
    continuity_reasons:rangeBridgeAuthoritative ? [...new Set([...continuityReasons, 'verified_source_range'])]
      : verifiedSourceGap ? [...new Set([...continuityReasons, 'verified_source_gap'])] : [...continuityReasons], unknown_session_gap_count:unknownSessionGapCount,
    expected_closures:expectedClosures.slice(0, 32), suspicious_gaps:suspiciousGaps.slice(0, 32),
    continuity_results:continuityResults.slice(0, 32),
    audit_expected_closures:auditExpectedClosures.slice(0, 32),
    audit_suspicious_gaps:auditSuspiciousGaps.slice(0, 32),
    ...policyFields }
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

export function periodMarketSourceAuthorization({ userId, strategyId, strategyScope, tradingAccountId } = {}) {
  const scope = String(strategyScope || '').trim().toLowerCase()
  const ownerId = Number(userId)
  const accountId = Number(tradingAccountId)
  const normalizedStrategyId = Number(strategyId)
  if (scope === 'private' && Number.isSafeInteger(ownerId) && ownerId > 0) {
    if (Number.isSafeInteger(accountId) && accountId > 0) {
      return {
        sql:`mds.bridge_user_id = ? AND EXISTS (
          SELECT 1 FROM trading_accounts review_account
          WHERE review_account.id = ? AND review_account.user_id = ?
            AND UPPER(COALESCE(review_account.broker_server, '')) = UPPER(COALESCE(mds.broker_server, ''))
            AND CAST(COALESCE(review_account.login_account, 0) AS CHAR) = CAST(COALESCE(mds.account_login, 0) AS CHAR)
        )`,
        params:[ownerId, accountId, ownerId],
        mode:'private_account',
      }
    }
    return { sql:'mds.bridge_user_id = ?', params:[ownerId], mode:'private_user' }
  }
  if (scope === 'platform' && Number.isSafeInteger(normalizedStrategyId) && normalizedStrategyId > 0) {
    return {
      // Market candles are exchange/broker market evidence, not account-owned
      // trade evidence.  Keep the observer strategy in the caller's frozen
      // scope, while selecting a canonical source only by timestamp quality.
      // Trade/order/position ownership is enforced by their own queries and is
      // intentionally not relaxed here.
      sql:`mds.clock_status IN (${TRUSTED_MARKET_CLOCK_STATUSES.map(() => '?').join(', ')})`,
      params:[...TRUSTED_MARKET_CLOCK_STATUSES],
      mode:'platform_shared_market',
      policy_version:PERIOD_MARKET_SOURCE_POLICY_VERSION,
    }
  }
  // Compatibility for older direct callers without a frozen strategy scope.
  // Runtime period reviews always pass an explicit scope and therefore never
  // use this legacy administrator-only branch.
  return { sql:"u.role = 'admin'", params:[], mode:'legacy_admin' }
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
    const rows = await queryAll(`SELECT source_id, broker_time, open_time_utc_msc AS time_utc_msc, open_price AS open, high_price AS high,
      low_price AS low, close_price AS close, tick_volume, spread
    FROM market_candles WHERE source_id IN (${ids.map(() => '?').join(',')}) AND standard_symbol = ? AND timeframe = ?
      AND open_time_utc_msc >= ? AND open_time_utc_msc < ? ORDER BY open_time_utc_msc LIMIT ?`, [
    ...ids, stripBrokerSuffix(symbol), timeframe, startUtcMs - historyLookback * interval,
    endUtcMs, MAX_REVIEW_WINDOW_CANDLES * 4,
  ])
    const merged = new Map()
    for (const row of rows) {
      const brokerTime = String(row.broker_time || '').trim() || null
      merged.set(Number(row.time_utc_msc), { ...row, broker_time:brokerTime, time:brokerTime })
    }
    return [...merged.values()].sort((a, b) => Number(a.time_utc_msc) - Number(b.time_utc_msc))
  }
  const requestedSourceId = Number(options.sourceId || options.source_id) > 0
    ? Number(options.sourceId || options.source_id) : null
  const requestedSourceKey = String(options.sourceKey || options.source_key || '').trim()
  const candidateIdentities = Array.isArray(options.sourceCandidates)
    ? options.sourceCandidates.filter(item => item && typeof item === 'object') : []
  const candidateIds = [...new Set(candidateIdentities.map(item => Number(item.source_id || item.id)).filter(id => id > 0))]
  const candidateKeys = [...new Set(candidateIdentities.map(item => String(item.source_key || '').trim()).filter(Boolean))]
  const sourceSelector = requestedSourceId ? 'AND mds.id = ?' : requestedSourceKey ? 'AND mds.source_key = ?'
    : candidateIds.length || candidateKeys.length
      ? `AND (${[
        candidateIds.length ? `mds.id IN (${candidateIds.map(() => '?').join(',')})` : null,
        candidateKeys.length ? `mds.source_key IN (${candidateKeys.map(() => '?').join(',')})` : null,
      ].filter(Boolean).join(' OR ')})` : ''
  const sourceSelectorParams = requestedSourceId ? [requestedSourceId] : requestedSourceKey ? [requestedSourceKey]
    : [...candidateIds, ...candidateKeys]
  const sourceAuthorization = periodMarketSourceAuthorization({
    userId,
    strategyId:options.strategyId ?? options.strategy_id,
    strategyScope:options.strategyScope ?? options.strategy_scope,
    tradingAccountId:options.tradingAccountId ?? options.trading_account_id,
  })
  const hasFrozenSourceSelector = Boolean(requestedSourceId || requestedSourceKey || candidateIds.length || candidateKeys.length)
  // Without a frozen source candidate, the shared-market fallback must come
  // from the platform bridge/admin source.  Otherwise a complete private
  // user's cache could accidentally become platform review evidence.
  const canonicalPlatformRoleFilter = sourceAuthorization.mode === 'platform_shared_market'
    && !hasFrozenSourceSelector ? " AND u.role = 'admin'" : ''
  const existingSource = await queryOne(`SELECT mds.id, mds.broker_server, mds.account_login, mds.source_key,
      mds.timezone_offset_minutes, mds.clock_status
    FROM market_data_sources mds JOIN users u ON u.id = mds.bridge_user_id
    WHERE ${sourceAuthorization.sql}${canonicalPlatformRoleFilter} AND EXISTS (SELECT 1 FROM market_candles candles
      WHERE candles.source_id = mds.id AND candles.standard_symbol = ? AND candles.timeframe = ? LIMIT 1)
      ${sourceSelector}
    ORDER BY (mds.clock_status = 'calibrated') DESC, mds.last_calibrated_at DESC, mds.id DESC LIMIT 1`,
  [...sourceAuthorization.params, stripBrokerSuffix(symbol), timeframe, ...sourceSelectorParams])
  let sourceId = Number(existingSource?.id)
  // A source is still selected as one exact source for this symbol/timeframe
  // window.  Platform reviews may replace it with the canonical market source
  // when the frozen cache is incomplete, but never merge candles across sources.
  let rows = sourceId ? await readStored([sourceId]) : []
  let periodRows = rows.filter(row => Number(row.time_utc_msc) >= startUtcMs && Number(row.time_utc_msc) < endUtcMs)
  const existingIdentity = sourceIdentityFromRow(existingSource || {})
  const requestedIdentity = sourceIdentityFromRow({ source_id:requestedSourceId, source_key:requestedSourceKey })
  const sourceSelectionMeta = {
    source_policy_version:sourceAuthorization.policy_version || PERIOD_MARKET_SOURCE_POLICY_VERSION,
    source_selection_mode:sourceAuthorization.mode,
    source_selection_changed:false,
    source_selection_reason:existingSource
      ? (requestedSourceId || requestedSourceKey || candidateIds.length || candidateKeys.length
        ? 'frozen_or_cached_source' : 'canonical_cached_source') : null,
    requested_source_identity:requestedIdentity.source_id || requestedIdentity.source_key ? requestedIdentity : null,
    candidate_source_identities:candidateIdentities.length ? candidateIdentities.map(sourceIdentityFromRow) : [],
  }
  let marketMeta = existingSource ? { source:'mysql_period_cache', source_id:sourceId,
    source_key:existingIdentity.source_key, platform:existingIdentity.platform,
    broker_server:existingIdentity.broker_server, account_login:existingIdentity.account_login,
    source_identity:existingIdentity,
    ...sourceSelectionMeta,
    selected_source_identity:existingIdentity.source_id ? existingIdentity : null,
    timezone_offset_minutes:existingSource.timezone_offset_minutes, clock_status:existingSource.clock_status } : {}
  let coverage = assessReviewCandleCoverage(periodRows, startUtcMs, endUtcMs, timeframe, {
    ...marketMeta, strictSessionPolicy:options.strictSessionPolicy === true,
    ignoreMarketSessionPolicy:true, env:{},
    standardSymbol:stripBrokerSuffix(symbol), sourceId, sourceKey:existingIdentity.source_key,
  })
  if (!coverage.complete) {
    const hydrated = await platformRates(userId, { symbol, timeframe, count, review_window:true,
      start_utc_msc:startUtcMs - historyLookback * interval, end_utc_msc:endUtcMs })
    sourceId = Number(hydrated?.market_meta?.source_id)
    if (hydrated?.status === 'error' || !sourceId) throw new Error(hydrated?.error || hydrated?.message || 'period_market_source_unavailable')
    // Bridge hydration is only a transport result.  Private review data still
    // passes exact account authorization.  Platform review K-lines are shared
    // market evidence, so a canonical platform source may replace an absent
    // or incomplete frozen cache source; the replacement is recorded below.
    const hydratedSourceSelector = sourceAuthorization.mode === 'platform_shared_market' ? '' : ` ${sourceSelector}`
    const hydratedSourceSelectorParams = sourceAuthorization.mode === 'platform_shared_market' ? [] : sourceSelectorParams
    const hydratedSourceRoleFilter = sourceAuthorization.mode === 'platform_shared_market' ? " AND u.role = 'admin'" : ''
    const hydratedSource = await queryOne(`SELECT mds.id, mds.broker_server, mds.account_login, mds.source_key,
        mds.timezone_offset_minutes, mds.clock_status
      FROM market_data_sources mds JOIN users u ON u.id = mds.bridge_user_id
      WHERE ${sourceAuthorization.sql}${hydratedSourceRoleFilter} AND mds.id = ?${hydratedSourceSelector}`,
    [...sourceAuthorization.params, sourceId, ...hydratedSourceSelectorParams])
    if (!hydratedSource) throw new Error('period_market_source_unauthorized')
    rows = await readStored([sourceId])
    const hydratedIdentity = sourceIdentityFromRow(hydratedSource || { id:sourceId })
    const changed = Boolean((requestedSourceId && requestedSourceId !== hydratedIdentity.source_id)
      || (requestedSourceKey && requestedSourceKey !== hydratedIdentity.source_key)
      || ((candidateIds.length || candidateKeys.length)
        && !candidateIds.includes(hydratedIdentity.source_id)
        && !candidateKeys.includes(hydratedIdentity.source_key)))
    marketMeta = { ...(hydrated.market_meta || {}), source_id:sourceId,
      source_key:hydratedIdentity.source_key || hydrated.market_meta?.source_key || null,
      platform:hydratedIdentity.platform || hydrated.market_meta?.platform || null,
      broker_server:hydratedIdentity.broker_server || hydrated.market_meta?.broker_server || null,
      account_login:hydratedIdentity.account_login || hydrated.market_meta?.account_login || null,
      source_identity:hydratedIdentity.source_id ? hydratedIdentity : hydrated.market_meta?.source_identity || null,
      ...sourceSelectionMeta,
      source_selection_changed:changed,
      source_selection_reason:changed ? 'canonical_platform_fallback' : 'frozen_source_hydrated',
      selected_source_identity:hydratedIdentity.source_id ? hydratedIdentity : null,
    }
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
    ignoreMarketSessionPolicy:true, env:{},
    standardSymbol:stripBrokerSuffix(symbol), sourceId, sourceKey:marketMeta.source_key,
  })
  const continuityMeta = {
    ...marketMeta,
    cache_internal_gap_detected:Boolean(marketMeta.cache_internal_gap_detected || !coverage.complete),
    cache_internal_gap_unresolved:coverage.continuity_status === 'verified_source_gap'
      ? false : Boolean(marketMeta.cache_internal_gap_unresolved || !coverage.complete),
    cache_internal_gap_status:coverage.continuity_status === 'verified_source_gap'
      ? 'verified_source_gap' : (marketMeta.cache_internal_gap_status || null),
    cache_internal_gap_verified_source:coverage.continuity_status === 'verified_source_gap'
      || marketMeta.cache_internal_gap_verified_source === true,
    cache_internal_gap_details:Array.isArray(coverage.suspicious_gaps) ? coverage.suspicious_gaps : [],
    continuity_calendar_version:coverage.continuity_calendar_version || marketMeta.continuity_calendar_version || null,
    continuity_engine_version:coverage.continuity_engine_version || marketMeta.continuity_engine_version || null,
    continuity_policy_id:coverage.continuity_policy_id || marketMeta.continuity_policy_id || null,
    continuity_policy_version:coverage.continuity_policy_version || marketMeta.continuity_policy_version || null,
    continuity_policy_hash:coverage.continuity_policy_hash || marketMeta.continuity_policy_hash || null,
    continuity_policy_match:coverage.continuity_policy_match ?? marketMeta.continuity_policy_match ?? null,
    continuity_policy_mode:coverage.continuity_policy_mode || marketMeta.continuity_policy_mode || null,
    expected_closures:coverage.expected_closures || marketMeta.expected_closures || [],
    continuity_status:coverage.continuity_status || marketMeta.continuity_status || null,
    continuity_reason:coverage.continuity_reason || marketMeta.continuity_reason || null,
    continuity_reasons:coverage.continuity_reasons || marketMeta.continuity_reasons || [],
    unknown_session_gap_count:Number(coverage.unknown_session_gap_count || marketMeta.unknown_session_gap_count || 0),
  }
  return { sourceId, interval, rates, periodRates, marketMeta:continuityMeta, coverage }
}

export async function buildDailyPeriodMarketEvidence({ userId, strategyId, strategyScope = null,
  tradingAccountId = null, symbols = [], startUtcMs, endUtcMs, sources = [] } = {}) {
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
  const sourceIdentities = frozenSourceIdentities(sources)
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
  const result = { schema_version:3, coverage_policy_version:2, source_policy_version:PERIOD_MARKET_SOURCE_POLICY_VERSION,
    status:'complete', reason:null, generated_at:new Date().toISOString(), uses_full_period_candles:true,
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
          ignoreMarketSessionPolicy:true,
          env:{},
          sourceCandidates:sourceIdentities,
          strategyId,
          strategyScope,
          tradingAccountId,
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
          source_policy_version:loaded.marketMeta?.source_policy_version || PERIOD_MARKET_SOURCE_POLICY_VERSION,
          source_selection_mode:loaded.marketMeta?.source_selection_mode || null,
          source_selection_changed:Boolean(loaded.marketMeta?.source_selection_changed),
          source_selection_reason:loaded.marketMeta?.source_selection_reason || null,
          requested_source_identity:loaded.marketMeta?.requested_source_identity || null,
          selected_source_identity:loaded.marketMeta?.selected_source_identity || null,
          source_identity:loaded.marketMeta?.source_identity || {
            source_id:loaded.marketMeta?.source_id || loaded.sourceId || null,
            source_key:loaded.marketMeta?.source_key || null,
            platform:loaded.marketMeta?.platform || null,
            broker_server:loaded.marketMeta?.broker_server || null,
            account_login:loaded.marketMeta?.account_login || null,
          },
           coverage:{ endpoint_complete:loaded.coverage.endpoint_complete, internal_gap_count:loaded.coverage.internal_gap_count,
             max_gap_ms:loaded.coverage.max_gap_ms, continuity_status:loaded.coverage.continuity_status || null,
             continuity_reason:loaded.coverage.continuity_reason || null,
             continuity_reasons:loaded.coverage.continuity_reasons || [],
             unknown_session_gap_count:Number(loaded.coverage.unknown_session_gap_count || 0),
             expected_closures:loaded.coverage.expected_closures || [],
             suspicious_gaps:loaded.coverage.suspicious_gaps || [],
             continuity_results:loaded.coverage.continuity_results || [],
             continuity_calendar_version:loaded.coverage.continuity_calendar_version || null,
             continuity_engine_version:loaded.coverage.continuity_engine_version || null,
             continuity_policy_id:loaded.coverage.continuity_policy_id || null,
             continuity_policy_version:loaded.coverage.continuity_policy_version || null,
             continuity_policy_hash:loaded.coverage.continuity_policy_hash || null,
             continuity_policy_match:loaded.coverage.continuity_policy_match ?? null,
             continuity_policy_mode:loaded.coverage.continuity_policy_mode || null },
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
        first_time_utc_msc:value.first_time_utc_msc, last_time_utc_msc:value.last_time_utc_msc,
        source_policy_version:value.source_policy_version || market.source_policy_version || null,
        source_selection_mode:value.source_selection_mode || null,
        source_selection_changed:Boolean(value.source_selection_changed),
        source_selection_reason:value.source_selection_reason || null,
        source_identity:value.source_identity || null, coverage:value.coverage || null, summary:value.summary || null,
      }]))
    }
    return { period_case_id:Number(row.id), period_key:row.period_key, status:market.status || 'unavailable', symbols }
  })
}
