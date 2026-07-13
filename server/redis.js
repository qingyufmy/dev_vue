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
    db: parseInt(process.env.REDIS_DB || '0'),
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

export async function cacheGetJSON(key) {
  const r = getRedis()
  if (!r) return null
  try {
    const raw = await r.get(key)
    return raw ? JSON.parse(raw) : null
  } catch (err) {
    console.error('[Redis] cacheGetJSON error:', err.message)
    return null
  }
}

export async function cacheSetJSON(key, value, ttlSeconds) {
  const r = getRedis()
  if (!r) return
  try {
    const json = JSON.stringify(value)
    if (ttlSeconds) {
      await r.set(key, json, 'EX', ttlSeconds)
    } else {
      await r.set(key, json)
    }
  } catch (err) {
    console.error('[Redis] cacheSetJSON error:', err.message)
  }
}

export async function cacheDel(key) {
  const r = getRedis()
  if (!r) return
  try {
    await r.del(key)
  } catch (err) {
    console.error('[Redis] cacheDel error:', err.message)
  }
}
