import { expect, it } from 'vitest'
import { evaluateMembership, type MembershipState } from '../src/modules/commerce/domain/membership.js'

const state = (): MembershipState => ({ userId: 2, planCode: 'pro', billingPeriodCode: '', sourceCode: null,
  expirationKind: 'at_time', expiresAtUtc: '2026-09-07T01:00:00.123Z', revision: '9007199254740993' })
it('expires at the exact UTC boundary without changing the stored plan or revision', () => {
  const source = state()
  expect(evaluateMembership(source, new Date('2026-09-07T01:00:00.122Z')).effectivePlan).toBe('pro')
  for (const now of ['2026-09-07T01:00:00.123Z', '2026-09-07T01:00:00.124Z']) {
    expect(evaluateMembership(source, new Date(now))).toMatchObject({ storedPlan: 'pro', effectivePlan: 'free', expired: true, revision: '9007199254740993' })
  }
  expect(source).toEqual(state())
})
it('preserves explicit no-expiry current state without producing a grant', () => {
  expect(evaluateMembership({ ...state(), expirationKind: 'no_expiry', expiresAtUtc: null }, new Date('2026-09-07T00:00:00Z')))
    .toMatchObject({ effectivePlan: 'pro', expired: false, expiresAtUtc: null })
})
it('rejects ambiguous, invalid or contradictory expiration and an invalid clock', () => {
  for (const expiry of ['2026-09-07 01:00:00', '2026-02-30T01:00:00.000Z', '2026-09-07T09:00:00.123+08:00', null]) {
    expect(() => evaluateMembership({ ...state(), expiresAtUtc: expiry }, new Date())).toThrow('membership_expiry_invalid')
  }
  expect(() => evaluateMembership({ ...state(), expirationKind: 'no_expiry' }, new Date())).toThrow('membership_expiry_invalid')
  expect(() => evaluateMembership(state(), new Date('invalid'))).toThrow('membership_clock_invalid')
})
