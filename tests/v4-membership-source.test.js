import { expect, it } from 'vitest'
import { inspectMembershipSources } from '../scripts/lib/v4-membership-source.mjs'
import { paymentMatchFixture } from './fixtures/payment-match-fixture.mjs'
const user = () => ({ id: '2', role: 'admin', plan: 'plus', plan_period: 'year', plan_source: 'gift',
  plan_expires_at: '2027-01-01 13:14:15', updated_at: '2026-09-01 12:00:00' })
it('keeps current membership independent of a different paid order and completed delivery', () => {
  const order = { ...paymentMatchFixture().order, status: 'paid', plan: 'pro', paid_at: '2026-09-01 12:00:00' }
  const effect = { id: '9', user_id: '2', order_id: order.order_id, status: 'completed', attempt_count: '1', next_attempt_at: order.paid_at,
    locked_at: null, completed_at: order.paid_at, last_error: null, created_at: order.paid_at, updated_at: order.paid_at }
  const result = inspectMembershipSources([user()], [order], [effect]), entry = result.entries[0]
  expect(entry.source).toEqual(user())
  expect(entry).toMatchObject({ paidOrderSourceIds: ['1'], completedDeliverySourceIds: ['9'],
    currentStateDerivedFromPayments: false, createsHistoricalActivation: false, grantsEntitlement: false })
  expect(entry.expiry.utc).toBeNull()
  expect(result.blockers.map(b => b.code)).toContain('expiry_time_basis_required')
})
it('preserves NULL and unknown plans instead of granting lifetime membership or defaulting free', () => {
  for (const plan of ['pro', null, 'historic-plan']) {
    const result = inspectMembershipSources([{ ...user(), plan, plan_expires_at: null }], [], [])
    expect(result.entries[0].source.plan).toBe(plan)
    expect(result.blockers.map(b => b.code)).toContain('unbounded_membership_policy_required')
    expect(result.fullMembershipConverted).toBe(false)
  }
})
it('rejects duplicate users, missing payment owners and malformed source timestamps', () => {
  expect(() => inspectMembershipSources([user(), user()], [], [])).toThrow('membership_source_identity_invalid')
  expect(() => inspectMembershipSources([], [paymentMatchFixture().order], [])).toThrow('payment_source_user_missing')
  expect(() => inspectMembershipSources([{ ...user(), plan_expires_at: 'not-a-date' }], [], [])).toThrow()
})
