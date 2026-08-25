import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/redis.js', () => ({
  getRedis:vi.fn(() => null),
  isRedisAvailable:vi.fn(() => false),
}))

vi.mock('../../server/routes/ai/market-data.js', () => ({ mt5Bridge:vi.fn() }))

const {
  POSITION_GUARD_QUOTE_FETCH_TIMEOUT_MS,
  POSITION_GUARD_QUOTE_LOCK_TTL_MS,
  getPositionGuardQuote,
  positionGuardQuoteCacheKeys,
  resetPositionGuardQuoteCacheForTests,
  validatePositionGuardQuoteSnapshot,
} = await import('../../server/routes/ai/position-guard-quote-cache.js')

const route = {
  userId:7,
  tradingAccountId:11,
  terminalInstanceId:'terminal-a',
  connectionEpoch:3,
  accountRef:{ broker_server:'Broker-Demo', login:'12345' },
  symbol:'XAUUSD.s',
}
const nowValue = 1_800_000_000_000
const liveQuote = overrides => ({
  status:'success', bid:3000, ask:3000.2, observed_at_utc_msc:nowValue,
  clock_status:'verified', symbol_trade_mode:4, market_state:'open', ...overrides,
})

function fakeRedis() {
  const values = new Map()
  return {
    values,
    get:vi.fn(async key => values.get(key) ?? null),
    set:vi.fn(async (key, value, mode, ttlMode) => {
      if (mode === 'NX' && values.has(key)) return null
      values.set(key, value)
      return 'OK'
    }),
    eval:vi.fn(async (_script, _count, key, token) => {
      if (values.get(key) !== token) return 0
      values.delete(key)
      return 1
    }),
  }
}

describe('position guard quote cache', () => {
  beforeEach(() => resetPositionGuardQuoteCacheForTests())

  it('binds cache keys to the complete terminal route', () => {
    const first = positionGuardQuoteCacheKeys(route)
    const second = positionGuardQuoteCacheKeys({ ...route, connectionEpoch:4 })
    expect(first.cacheKey).not.toBe(second.cacheKey)
    expect(first.lockKey).toContain('position_guard:quote_lock:v1:')
  })

  it('rejects stale and cross-account snapshots', () => {
    const { route:normalized } = positionGuardQuoteCacheKeys(route)
    const snapshot = { route:normalized, quote:liveQuote(), cached_at_utc_msc:nowValue }
    expect(validatePositionGuardQuoteSnapshot(snapshot, route, { now:nowValue })).toMatchObject({ ok:true })
    expect(validatePositionGuardQuoteSnapshot(snapshot, { ...route, tradingAccountId:12 }, { now:nowValue })).toMatchObject({ ok:false, code:'position_guard_quote_identity_mismatch' })
    expect(validatePositionGuardQuoteSnapshot(snapshot, route, { now:nowValue + 5_001 })).toMatchObject({ ok:false, code:'position_guard_quote_stale' })
  })

  it('coalesces same-process misses without Redis', async () => {
    let release
    const bridge = vi.fn(() => new Promise(resolve => { release = () => resolve(liveQuote()) }))
    const first = getPositionGuardQuote(route, { bridge, redisAvailable:false, now:() => nowValue })
    const second = getPositionGuardQuote(route, { bridge, redisAvailable:false, now:() => nowValue })
    await vi.waitFor(() => expect(bridge).toHaveBeenCalledTimes(1))
    release()
    await expect(first).resolves.toMatchObject({ ok:true, source:'bridge' })
    await expect(second).resolves.toMatchObject({ ok:true, source:'bridge' })
    expect(bridge.mock.calls[0][3].timeoutMs).toBe(POSITION_GUARD_QUOTE_FETCH_TIMEOUT_MS)
  })

  it('uses Redis for a fresh shared quote without Bridge traffic', async () => {
    const redis = fakeRedis()
    const { cacheKey, route:normalized } = positionGuardQuoteCacheKeys(route)
    redis.values.set(cacheKey, JSON.stringify({ route:normalized, quote:liveQuote(), cached_at_utc_msc:nowValue }))
    const bridge = vi.fn()
    await expect(getPositionGuardQuote(route, { bridge, redis, redisAvailable:true, now:() => nowValue }))
      .resolves.toMatchObject({ ok:true, source:'redis' })
    expect(bridge).not.toHaveBeenCalled()
  })

  it('does not bypass a lock held by another instance', async () => {
    const redis = fakeRedis()
    const { lockKey } = positionGuardQuoteCacheKeys(route)
    redis.values.set(lockKey, 'other-token')
    const bridge = vi.fn()
    const result = await getPositionGuardQuote(route, {
      bridge, redis, redisAvailable:true, now:() => nowValue, waitFn:async () => {},
    })
    expect(result).toMatchObject({ ok:false, code:'position_guard_quote_coalesced_pending', retryable:true })
    expect(bridge).not.toHaveBeenCalled()
  })

  it('keeps the lock TTL longer than the Bridge timeout', () => {
    expect(POSITION_GUARD_QUOTE_LOCK_TTL_MS).toBeGreaterThan(POSITION_GUARD_QUOTE_FETCH_TIMEOUT_MS)
  })
})
