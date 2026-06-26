import Redis from 'ioredis'

let redis = null
let _redisAvailable = false

/**
 * Get or create Redis client (singleton).
 * Returns null if Redis is not configured or unavailable.
 */
export function getRedis() {
  if (redis) return redis

  const host = process.env.REDIS_HOST
  if (!host) {
    console.log('[Redis] No REDIS_HOST configured, caching disabled')
    return null
  }

  redis = new Redis({
    host,
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
    retryStrategy: (times) => {
      if (times > 10) return null // stop retrying
      return Math.min(times * 200, 5000)
    },
    maxRetriesPerRequest: 3,
    connectTimeout: 5000,
    lazyConnect: true,
  })

  redis.on('error', (err) => {
    if (_redisAvailable) {
      console.error('[Redis] Connection error:', err.message)
      _redisAvailable = false
    }
  })

  redis.on('connect', () => {
    _redisAvailable = true
    console.log('[Redis] Connected to', `${host}:${process.env.REDIS_PORT || 6379}`)
  })

  redis.on('close', () => {
    _redisAvailable = false
  })

  // Connect asynchronously — don't block startup
  redis.connect().catch(() => {})

  return redis
}

/** Check if Redis is currently available */
export function isRedisAvailable() {
  return _redisAvailable
}

/**
 * Safe Redis GET — returns null on any error (graceful degradation)
 */
export async function cacheGet(key) {
  try {
    const r = getRedis()
    if (!r || !_redisAvailable) return null
    return await r.get(key)
  } catch {
    return null
  }
}

/**
 * Safe Redis SET — silently fails on error
 */
export async function cacheSet(key, value, ttlSeconds) {
  try {
    const r = getRedis()
    if (!r || !_redisAvailable) return
    if (ttlSeconds) {
      await r.set(key, value, 'EX', ttlSeconds)
    } else {
      await r.set(key, value)
    }
  } catch {}
}

/**
 * Safe Redis DEL — silently fails on error
 */
export async function cacheDel(...keys) {
  try {
    const r = getRedis()
    if (!r || !_redisAvailable) return
    await r.del(...keys)
  } catch {}
}

/**
 * Safe Redis GET with JSON parse — returns null on any error
 */
export async function cacheGetJSON(key) {
  const raw = await cacheGet(key)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

/**
 * Safe Redis SET with JSON stringify
 */
export async function cacheSetJSON(key, value, ttlSeconds) {
  try { await cacheSet(key, JSON.stringify(value), ttlSeconds) } catch {}
}
