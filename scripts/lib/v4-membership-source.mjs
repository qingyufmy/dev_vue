import { exactKeys, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { representIdentityValue as represent } from './v4-identity-values.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'
import { inspectPaymentOrderSources } from './v4-payment-order-source.mjs'
import { inspectPaymentEffects } from './v4-payment-effects-source.mjs'

export const membershipSourceFields = Object.freeze({ id: ['int', false], role: ['varchar(20)', true], plan: ['varchar(20)', true],
  plan_period: ['varchar(20)', true], plan_source: ['varchar(20)', true], plan_expires_at: ['datetime', true], updated_at: ['datetime', true] })

export function inspectMembershipSources(users, orders, effects) {
  check(Array.isArray(users), 'membership_source_scope_invalid')
  const seen = new Set(), entries = [], blockers = []
  for (const source of users) {
    exactKeys(source, Object.keys(membershipSourceFields))
    for (const [field, [type, nullable]] of Object.entries(membershipSourceFields)) {
      if (type === 'datetime') inspectWallClock(source[field])
      else represent(source[field], type, nullable)
    }
    check(BigInt(source.id) > 0n && !seen.has(source.id), 'membership_source_identity_invalid'); seen.add(source.id)
    const add = code => blockers.push({ sourceId: source.id, code })
    if (!['free', 'plus', 'pro'].includes(source.plan)) add('plan_mapping_required')
    if (source.plan_expires_at !== null) add('expiry_time_basis_required')
    if (source.updated_at !== null) add('updated_time_basis_required')
    // NULL expiry is a stored fact, not proof of a purchased perpetual grant.
    if (source.plan !== 'free' && source.plan_expires_at === null) add('unbounded_membership_policy_required')
    entries.push({ sourceId: source.id, sourceHash: hash(source), source: { ...source },
      expiry: { raw: source.plan_expires_at, utc: null }, currentStateOnly: true,
      grantsEntitlement: false, createsHistoricalActivation: false, effectiveMembershipEvaluated: false })
  }
  const orderReview = inspectPaymentOrderSources(orders, seen), effectReview = inspectPaymentEffects(effects, orders)
  for (const entry of entries) {
    entry.paidOrderSourceIds = orderReview.entries.filter(order => order.source.user_id === entry.sourceId && order.source.status === 'paid').map(order => order.sourceId)
    entry.completedDeliverySourceIds = effectReview.entries.filter(effect => effect.source.user_id === entry.sourceId && effect.source.status === 'completed').map(effect => effect.sourceId)
    // Neither the latest paid order nor the delivery count determines current
    // membership: grants, revocations and later administrative changes may exist.
    entry.currentStateDerivedFromPayments = false
  }
  entries.sort((a, b) => BigInt(a.sourceId) < BigInt(b.sourceId) ? -1 : 1)
  return { version: 'membership-source/v1', sourceHash: hash(entries.map(entry => entry.source)), sourceFields: 7,
    entries, blockers, orderBlockers: orderReview.blockers, deliveryBlockers: effectReview.blockers,
    fullMembershipConverted: false, businessWritesEnabled: false }
}
