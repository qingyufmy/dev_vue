import { describe, expect, it } from 'vitest'
import { decorateMembership, getEffectivePlan, hasActiveMembership, isMembershipExpired } from '../server/membership.js'

describe('membership entitlement', () => {
  const now = new Date('2026-07-23T12:00:00+08:00').getTime()

  it('preserves the purchased plan while expiring its permissions', () => {
    const user = { role:'user', plan:'pro', plan_expires_at:'2026-07-22 23:59:59' }
    const decorated = decorateMembership(user, now)
    expect(decorated.plan).toBe('pro')
    expect(decorated.membershipExpired).toBe(true)
    expect(decorated.effectivePlan).toBe('free')
  })

  it('keeps a future or long-term membership active', () => {
    expect(getEffectivePlan({ plan:'plus', plan_expires_at:'2026-07-24 23:59:59' }, now)).toBe('plus')
    expect(getEffectivePlan({ plan:'pro', plan_expires_at:null }, now)).toBe('pro')
  })

  it('does not grant paid access from a stale plan label', () => {
    const expired = { role:'user', plan:'pro', plan_expires_at:'2020-01-01 00:00:00' }
    expect(isMembershipExpired(expired, now)).toBe(true)
    expect(hasActiveMembership(expired, 'pro')).toBe(false)
    expect(hasActiveMembership({ ...expired, role:'admin' }, 'pro')).toBe(true)
  })
})
