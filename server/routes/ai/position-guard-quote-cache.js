import crypto from 'node:crypto'
import { getRedis, isRedisAvailable } from '../../redis.js'
import { mt5Bridge } from './market-data.js'

export const POSITION_GUARD_QUOTE_TTL_SECONDS = 5
export const POSITION_GUARD_QUOTE_MAX_AGE_MS = 5_000
export const POSITION_GUARD_QUOTE_FETCH_TIMEOUT_MS = 3_000
export const POSITION_GUARD_QUOTE_LOCK_TTL_MS = 5_000

const WAIT_STEPS_MS = [40, 60, 100]
const TRUSTED_CLOCK_STATES = new Set(['verified', 'snapshot_pair_verified', 'terminal_verified'])
const localQuotes = new Map()
const inFlight = new Map()
const metrics = {
  cache_hit:0,
  cache_miss:0,
  bridge_fetch:0,
  coalesced_wait:0,
  stale_rejected:0,
  redis_error:0,
}

const text = value => String(value ?? '').trim()
const upper = value => text(value).toUpperCase()
const positiveInteger = value => Number.isSafeInteger(Number(value)) && Number(value) > 0
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function routeError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function normalizedRoute(input = {}) {
  const route = {
    user_id:Number(input.userId ?? input.user_id),
    trading_account_id:Number(input.tradingAccountId ?? input.trading_account_id),
    terminal_instance_id:text(input.terminalInstanceId ?? input.terminal_instance_id),
    connection_epoch:Number(input.connectionEpoch ?? input.connection_epoch),
    broker_server:upper(input.accountRef?.broker_server ?? input.broker_server),
    login_account:text(input.accountRef?.login ?? input.login_account),
    broker_symbol:upper(input.symbol ?? input.broker_symbol),
  }
  if (!positiveInteger(route.user_id) || !positiveInteger(route.trading_account_id)
    || !route.terminal_instance_id || !positiveInteger(route.connection_epoch)
    || !route.broker_server || !route.login_account || !route.broker_symbol) {
    throw routeError('position_guard_quote_route_invalid')
  }
  return route
}

function routeDigest(route) {
  return crypto.createHash('sha256').update(JSON.stringify(route)).digest('hex')
}

export function positionGuardQuoteCacheKeys(input = {}) {
  const route = normalizedRoute(input)
  const suffix = routeDigest(route)
  return {
    route,
    cacheKey:`position_guard:quote:v1:${suffix}`,
    lockKey:`position_guard:quote_lock:v1:${suffix}`,
  }
}

function sameRoute(left = {}, right = {}) {
  return Number(left.user_id) === Number(right.user_id)
    && Number(left.trading_account_id) === Number(right.trading_account_id)
    && text(left.terminal_instance_id) === text(right.terminal_instance_id)
    && Number(left.connection_epoch) === Number(right.connection_epoch)
    && upper(left.broker_server) === upper(right.broker_server)
    && text(left.login_account) === text(right.login_account)
    && upper(left.broker_symbol) === upper(right.broker_symbol)
}

export function validatePositionGuardQuoteSnapshot(snapshot, routeInput, {
  now = Date.now(), maxAgeMs = POSITION_GUARD_QUOTE_MAX_AGE_MS,
} = {}) {
  let route
  try { route = normalizedRoute(routeInput) } catch (error) {
    return { ok:false, code:error.code || error.message }
  }
  if (!snapshot || typeof snapshot !== 'object' || !sameRoute(snapshot.route, route)) {
    return { ok:false, code:'position_guard_quote_identity_mismatch' }
  }
  const quote = snapshot.quote && typeof snapshot.quote === 'object' ? snapshot.quote : null
  const bid = Number(quote?.bid)
  const ask = Number(quote?.ask)
  const observedAt = Number(quote?.observed_at_utc_msc)
  if (!Number.isFinite(bid) || bid <= 0 || !Number.isFinite(ask) || ask <= 0 || ask < bid) {
    return { ok:false, code:'position_guard_quote_price_invalid' }
  }
  if (!Number.isSafeInteger(observedAt) || observedAt <= 0 || observedAt > now + 2_000
    || now - observedAt > Math.max(1, Number(maxAgeMs) || POSITION_GUARD_QUOTE_MAX_AGE_MS)) {
    return { ok:false, code:'position_guard_quote_stale' }
  }
  if (!TRUSTED_CLOCK_STATES.has(text(quote.clock_status).toLowerCase())) {
    return { ok:false, code:'position_guard_quote_clock_untrusted' }
  }
  const tradeMode = Number(quote.symbol_trade_mode)
  if (quote.market_state && text(quote.market_state).toLowerCase() !== 'open') {
    return { ok:false, code:'position_guard_market_not_open' }
  }
  if (Number.isInteger(tradeMode) && tradeMode !== 4) {
    return { ok:false, code:'position_guard_symbol_trade_restricted' }
  }
  return { ok:true, route, quote:{ ...quote, bid, ask, observed_at_utc_msc:observedAt } }
}

function parseJson(raw) {
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

async function readRedisSnapshot(redis, cacheKey) {
  try { return parseJson(await redis.get(cacheKey)) } catch {
    metrics.redis_error += 1
    return null
  }
}

async function releaseLock(redis, lockKey, token) {
  try {
    await redis.eval(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
      1, lockKey, token,
    )
  } catch { metrics.redis_error += 1 }
}

async function fetchLiveQuote(route, bridge, now) {
  metrics.bridge_fetch += 1
  const quote = await bridge(route.user_id, 'quote', {
    symbol:route.broker_symbol,
    terminal_instance_id:route.terminal_instance_id,
    account_ref:{ broker_server:route.broker_server, login:route.login_account },
  }, { noFallback:true, timeoutMs:POSITION_GUARD_QUOTE_FETCH_TIMEOUT_MS })
  if (!quote || quote.status !== 'success') {
    return { ok:false, code:text(quote?.error || quote?.code || quote?.message) || 'position_guard_quote_unavailable' }
  }
  const snapshot = { route, quote, cached_at_utc_msc:now() }
  const validation = validatePositionGuardQuoteSnapshot(snapshot, route, { now:now() })
  return validation.ok ? { ok:true, snapshot, quote:validation.quote, source:'bridge' } : validation
}

function readLocal(cacheKey, route, now) {
  const snapshot = localQuotes.get(cacheKey)
  const validation = validatePositionGuardQuoteSnapshot(snapshot, route, { now:now() })
  if (validation.ok) return { ...validation, source:'memory' }
  if (snapshot) {
    localQuotes.delete(cacheKey)
    metrics.stale_rejected += 1
  }
  return null
}

async function directWithSingleflight(cacheKey, route, bridge, now) {
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey)
  const request = fetchLiveQuote(route, bridge, now)
    .then(result => {
      if (result.ok) localQuotes.set(cacheKey, result.snapshot)
      return result
    })
    .finally(() => inFlight.delete(cacheKey))
  inFlight.set(cacheKey, request)
  return request
}

export async function getPositionGuardQuote(routeInput, {
  bridge = mt5Bridge,
  redis = null,
  redisAvailable = null,
  now = () => Date.now(),
  waitFn = wait,
} = {}) {
  const { route, cacheKey, lockKey } = positionGuardQuoteCacheKeys(routeInput)
  const local = readLocal(cacheKey, route, now)
  if (local) {
    metrics.cache_hit += 1
    return local
  }

  const client = redis || getRedis()
  const available = redisAvailable == null ? Boolean(client && isRedisAvailable()) : Boolean(redisAvailable && client)
  if (!available) {
    metrics.cache_miss += 1
    return directWithSingleflight(cacheKey, route, bridge, now)
  }

  const cached = await readRedisSnapshot(client, cacheKey)
  const cachedValidation = validatePositionGuardQuoteSnapshot(cached, route, { now:now() })
  if (cachedValidation.ok) {
    localQuotes.set(cacheKey, cached)
    metrics.cache_hit += 1
    return { ...cachedValidation, source:'redis' }
  }
  if (cached) metrics.stale_rejected += 1
  metrics.cache_miss += 1

  const token = crypto.randomUUID()
  let acquired = false
  try {
    acquired = (await client.set(lockKey, token, 'NX', 'PX', POSITION_GUARD_QUOTE_LOCK_TTL_MS)) === 'OK'
  } catch { metrics.redis_error += 1 }
  if (acquired) {
    try {
      const result = await directWithSingleflight(cacheKey, route, bridge, now)
      if (result.ok) {
        try {
          await client.set(cacheKey, JSON.stringify(result.snapshot), 'EX', POSITION_GUARD_QUOTE_TTL_SECONDS)
        } catch { metrics.redis_error += 1 }
      }
      return result
    } finally {
      await releaseLock(client, lockKey, token)
    }
  }

  metrics.coalesced_wait += 1
  for (const milliseconds of WAIT_STEPS_MS) {
    await waitFn(milliseconds)
    const shared = await readRedisSnapshot(client, cacheKey)
    const validation = validatePositionGuardQuoteSnapshot(shared, route, { now:now() })
    if (validation.ok) {
      localQuotes.set(cacheKey, shared)
      return { ...validation, source:'redis_coalesced' }
    }
  }
  let lockStillExists = true
  try { lockStillExists = Boolean(await client.get(lockKey)) } catch { metrics.redis_error += 1 }
  if (lockStillExists) return { ok:false, code:'position_guard_quote_coalesced_pending', retryable:true }

  try {
    acquired = (await client.set(lockKey, token, 'NX', 'PX', POSITION_GUARD_QUOTE_LOCK_TTL_MS)) === 'OK'
  } catch { metrics.redis_error += 1 }
  if (!acquired) return { ok:false, code:'position_guard_quote_coalesced_pending', retryable:true }
  try {
    const result = await directWithSingleflight(cacheKey, route, bridge, now)
    if (result.ok) {
      try { await client.set(cacheKey, JSON.stringify(result.snapshot), 'EX', POSITION_GUARD_QUOTE_TTL_SECONDS) }
      catch { metrics.redis_error += 1 }
    }
    return result
  } finally {
    await releaseLock(client, lockKey, token)
  }
}

export function getPositionGuardQuoteCacheMetrics() {
  return { ...metrics, local_entries:localQuotes.size, in_flight:inFlight.size }
}

export function resetPositionGuardQuoteCacheForTests() {
  localQuotes.clear()
  inFlight.clear()
  for (const key of Object.keys(metrics)) metrics[key] = 0
}
