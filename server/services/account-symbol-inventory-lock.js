import crypto from 'node:crypto'
import { getRedis } from '../redis.js'
import { stripBrokerSuffix } from '../routes/ai/utils.js'

const REDIS_LOCK_PREFIX = 'auto:scheduler:lock:'
const LOCK_TTL_MS = 120000

export function accountSymbolInventoryLockKey(userId, symbol) {
  return `delivery_inventory:${Number(userId)}:${stripBrokerSuffix(String(symbol || '')).toUpperCase()}`
}
export async function acquireAccountSymbolInventoryLock(userId, symbol) {
  const key = accountSymbolInventoryLockKey(userId, symbol)
  const redis = getRedis()
  if (!redis) return { key, token:null }
  const token = crypto.randomUUID()
  try {
    const ok = await redis.set(`${REDIS_LOCK_PREFIX}${key}`, token, 'NX', 'PX', LOCK_TTL_MS)
    return { key, token:ok ? token : null }
  } catch (error) {
    console.error('[InventoryLock] acquire failed:', error.message)
    return { key, token:null }
  }
}

export async function releaseAccountSymbolInventoryLock(key, token) {
  const redis = getRedis()
  if (!redis || !key || !token) return false
  try {
    const result = await redis.eval(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
      1, `${REDIS_LOCK_PREFIX}${key}`, token,
    )
    return Number(result) > 0
  } catch (error) {
    console.error('[InventoryLock] release failed:', error.message)
    return false
  }
}
