import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import type { BridgeGatewayRoute } from '../src/modules/bridge/index.js'
import type { PositionProtectionRequest } from '../src/modules/execution/index.js'
const { make, review } = vi.hoisted(() => {
  const review = vi.fn(async () => ({ marker: 'review' }))
  return { review, make: vi.fn(() => ({ review })) }
})
vi.mock('../src/bootstrap/position-protection-review.js', () => ({ createTransactionPositionProtectionReviewer: make }))
import { createPositionProtectionReviewCapture } from '../src/bootstrap/position-protection-preparation.js'

const scope = { workflowId: '11111111-1111-8111-a111-111111111111', userId: 7, accountId: '5' }
const request = { ...scope } as PositionProtectionRequest
const db = {} as PoolConnection
const route = { userId: 7, accountId: '5', platform: 'mt5', terminalInstanceId: 'terminal', connectionEpoch: 1 } as BridgeGatewayRoute
beforeEach(() => { vi.clearAllMocks() })
describe('position protection transaction reviewer capture', () => {
  it('captures once before creating any SQL reader, and freezes route, scope and limits', async () => {
    const currentRoute = structuredClone(route), input = { ...scope }, limits = { maxAgeMs: 30000, maxInstrumentAgeMs: 300000 }
    const routes = { current: vi.fn(async () => currentRoute) }
    const capture = createPositionProtectionReviewCapture(routes, limits)
    limits.maxAgeMs = 1
    const bind = await capture(input)
    expect(routes.current).toHaveBeenCalledExactlyOnceWith('5')
    expect(make).not.toHaveBeenCalled()
    currentRoute.connectionEpoch = 2; input.workflowId = 'changed'
    const reviewer = bind(db)
    expect(make).toHaveBeenCalledExactlyOnceWith(db, route, { maxAgeMs: 30000, maxInstrumentAgeMs: 300000 })
    await expect(reviewer.review(request)).resolves.toEqual({ marker: 'review' })
    expect(routes.current).toHaveBeenCalledTimes(1)
  })
  it.each([null, { ...route, platform: 'mt4' }, { ...route, userId: 8 }, { ...route, accountId: '6' }])('keeps unavailable or foreign routes retryable', async current => {
    const bind = await createPositionProtectionReviewCapture({ current: async () => current as BridgeGatewayRoute | null },
      { maxAgeMs: 1000, maxInstrumentAgeMs: 1000 })(scope)
    await expect(bind(db).review(request)).rejects.toThrow('position_protection_context_unavailable')
    expect(make).not.toHaveBeenCalled()
  })
  it('does not reuse the captured reviewer for another workflow', async () => {
    const bind = await createPositionProtectionReviewCapture({ current: async () => route }, { maxAgeMs: 1000, maxInstrumentAgeMs: 1000 })(scope)
    await expect(bind(db).review({ ...request, workflowId: 'different' })).rejects.toThrow('position_protection_context_unavailable')
    expect(review).not.toHaveBeenCalled()
  })
  it('defers a Redis failure until a new review actually needs route facts', async () => {
    const failure = new Error('redis_unavailable')
    const bind = await createPositionProtectionReviewCapture({ current: async () => { throw failure } },
      { maxAgeMs: 1000, maxInstrumentAgeMs: 1000 })(scope)
    expect(make).not.toHaveBeenCalled()
    await expect(bind(db).review(request)).rejects.toBe(failure)
  })
  it.each([{ maxAgeMs: 0, maxInstrumentAgeMs: 1000 }, { maxAgeMs: 60001, maxInstrumentAgeMs: 1000 },
    { maxAgeMs: 1000, maxInstrumentAgeMs: 0 }, { maxAgeMs: 1000, maxInstrumentAgeMs: 300001 }])('rejects invalid freshness bounds before Redis', limits => {
    const current = vi.fn()
    expect(() => createPositionProtectionReviewCapture({ current }, limits)).toThrow('position_protection_read_limits_invalid')
    expect(current).not.toHaveBeenCalled()
  })
})
