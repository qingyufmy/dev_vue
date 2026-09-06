import { describe, expect, it } from 'vitest'
import { accountMetricsUpdateSchema } from './index'

const metrics = { balance: '100', equity: '100', margin: '0', free_margin: '100', floating_profit: '0', currency: 'USD', observed_at: '2026-09-06T08:00:00.000Z' }

describe('account metrics clock compatibility', () => {
  it('accepts old producers and preserves explicit zero and null from new producers', () => {
    expect(accountMetricsUpdateSchema.parse(metrics)).not.toHaveProperty('clock_status')
    for (const offset of [0, -210, 345, null]) {
      expect(accountMetricsUpdateSchema.parse({ ...metrics, timezone_offset_minutes: offset, clock_status: 'unavailable' }).timezone_offset_minutes).toBe(offset)
    }
  })

  it.each([
    { timezone_offset_minutes: 180 }, { clock_status: 'stale' },
    { timezone_offset_minutes: '180', clock_status: 'calibrated' },
    { timezone_offset_minutes: -841, clock_status: 'calibrated' },
    { timezone_offset_minutes: 180, clock_status: 'default' },
  ])('rejects incomplete or malformed clock evidence %j', clock => {
    expect(accountMetricsUpdateSchema.safeParse({ ...metrics, ...clock }).success).toBe(false)
  })
})
