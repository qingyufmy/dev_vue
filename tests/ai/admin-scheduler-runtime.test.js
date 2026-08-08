import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../server/db.js', () => ({
  queryAll: vi.fn(),
  queryOne: vi.fn(),
}))

vi.mock('../../server/redis.js', () => ({
  getRedis: vi.fn(),
  isRedisAvailable: vi.fn(),
}))

vi.mock('../../server/routes/ai/rollout-governance.js', () => ({
  getAiRolloutHealth: vi.fn(),
}))

vi.mock('../../server/routes/ai/review-workflow.js', () => ({
  getReviewAdminHealth: vi.fn(),
}))

vi.mock('../../server/routes/ai/observer-channels.js', () => ({
  listObserverChannels: vi.fn(),
  listObserverSources: vi.fn(),
}))

vi.mock('../../server/bridge-ws.js', () => ({
  getConnectedBridgeStats: vi.fn(),
  getLatestBridgeMt5Clock: vi.fn(),
  isBridgeAlive: vi.fn(),
}))

import { readSchedulerRuntime } from '../../server/admin/ai-operations.js'
import * as redis from '../../server/redis.js'

describe('admin scheduler runtime fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redis.isRedisAvailable.mockReturnValue(true)
  })
  afterEach(() => vi.useRealTimers())

  it('derives runtime keys from strategy symbols when the Redis key index is empty', async () => {
    const fakeRedis = {
      smembers: vi.fn(async () => []),
      hgetall: vi.fn(async key => key === 'auto:scheduler:7:XAUUSD:state'
        ? { running:'1', stage:'idle', subscriber_count:'3', interval_minutes:'5' }
        : {}),
      scard: vi.fn(async () => 0),
    }
    redis.getRedis.mockReturnValue(fakeRedis)

    const result = await readSchedulerRuntime([{
      strategy_id:7, strategy_name:'道诚策略', symbols_json:'["XAUUSD"]', interval_minutes:5,
    }])

    expect(result).toMatchObject({ available:true })
    expect(result.schedulers).toHaveLength(1)
    expect(result.schedulers[0]).toMatchObject({
      key:'7:XAUUSD', strategy_id:7, symbol:'XAUUSD', running:true, subscriber_count:3,
    })
    expect(fakeRedis.hgetall).toHaveBeenCalledWith('auto:scheduler:7:XAUUSD:state')
  })

  it('uses the Redis cooldown TTL as the authoritative remaining time', async () => {
    const now = Date.parse('2026-08-05T05:00:00.000Z')
    vi.useFakeTimers({ now })
    const fakeRedis = {
      smembers: vi.fn(async () => ['7:XAUUSD']),
      hgetall: vi.fn(async () => ({
        running:'1', wait_reason:'cooldown', next_run_in_seconds:'145',
        next_run_at_utc:'2026-08-05T05:02:25.000Z', state_updated_at_utc:'2026-08-05T04:59:58.000Z',
        subscriber_count:'2',
      })),
      scard: vi.fn(async () => 2),
      ttl: vi.fn(async key => key === 'auto:scheduler:cooldown:7:XAUUSD' ? 107 : -2),
    }
    redis.getRedis.mockReturnValue(fakeRedis)

    const result = await readSchedulerRuntime([{
      strategy_id:7, strategy_name:'道诚策略', symbols_json:'["XAUUSD"]', interval_minutes:5,
    }])

    expect(result.schedulers[0]).toMatchObject({
      next_run_in_seconds:107,
      next_run_at_utc:'2026-08-05T05:01:47.000Z',
      state_updated_at_utc:'2026-08-05T04:59:58.000Z',
    })
    expect(fakeRedis.ttl).toHaveBeenCalledWith('auto:scheduler:cooldown:7:XAUUSD')
  })

  it.each([0, -2])('does not resurrect a stale deadline when Redis cooldown TTL is %s', async ttl => {
    const now = Date.parse('2026-08-05T05:00:00.000Z')
    vi.useFakeTimers({ now })
    const fakeRedis = {
      smembers: vi.fn(async () => ['7:XAUUSD']),
      hgetall: vi.fn(async () => ({
        running:'1', wait_reason:'cooldown', next_run_in_seconds:'145',
        next_run_at_utc:'2026-08-05T05:02:25.000Z', subscriber_count:'2',
      })),
      scard: vi.fn(async () => 2),
      ttl: vi.fn(async () => ttl),
    }
    redis.getRedis.mockReturnValue(fakeRedis)

    const result = await readSchedulerRuntime([{
      strategy_id:7, strategy_name:'道诚策略', symbols_json:'["XAUUSD"]', interval_minutes:5,
    }])

    expect(result.schedulers[0]).toMatchObject({
      next_run_in_seconds:0,
      next_run_at_utc:'',
    })
  })
})
