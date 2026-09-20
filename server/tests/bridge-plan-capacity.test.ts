import { describe, expect, it, vi } from 'vitest'
import { ConnectionCapacityService } from '../src/modules/trading/application/trading-service.js'
import type { ConnectionLeaseStore } from '../src/modules/trading/application/trading-ports.js'

describe('plan-based Bridge capacity', () => {
  it.each([
    ['pro', 1, 0, 1], ['plus', 0, 0, 0], ['free', 0, 0, 0],
    ['expired-pro', 0, 0, 0], ['plus-with-grant', 0, 2, 2], ['pro-with-grant', 1, 2, 3],
  ] as const)('%s uses the same total for summary and connection admission', async (_plan, included, purchased, total) => {
    const claim = vi.fn(async () => ({ epoch: 'epoch' }))
    const leases = { count: async () => 0, claim } as unknown as ConnectionLeaseStore
    const service = new ConnectionCapacityService({ getIncludedCapacity: async () => included, getPurchasedCapacity: async () => purchased }, leases)
    expect(await service.summary(7)).toEqual({ included, purchased, total, active: 0, available: total })
    await service.connect({ userId: 7, accountId: 'account', terminalProfileId: 'profile', terminalInstanceId: 'terminal', connectionEpoch: 'epoch' })
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ capacity: total }))
  })
})
