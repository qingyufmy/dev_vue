import { describe, expect, it, vi, beforeEach } from 'vitest'

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
})

