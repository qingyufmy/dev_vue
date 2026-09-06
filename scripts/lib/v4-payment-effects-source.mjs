import { exactKeys, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { representIdentityValue as represent } from './v4-identity-values.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'

export const paymentEffectFields = Object.freeze({ id: ['bigint', false], order_id: ['varchar(100)', false], user_id: ['int', false],
  status: ['varchar(20)', false], attempt_count: ['int', false], next_attempt_at: ['datetime', false], locked_at: ['datetime', true],
  completed_at: ['datetime', true], last_error: ['varchar(1000)', true], created_at: ['datetime', false], updated_at: ['datetime', false] })

export function inspectPaymentEffects(rows, orders) {
  check(Array.isArray(rows) && Array.isArray(orders), 'payment_effect_scope_invalid')
  const ids = new Set(), externalIds = new Set(), entries = [], blockers = []
  for (const source of rows) {
    exactKeys(source, Object.keys(paymentEffectFields))
    const times = {}
    for (const [field, [type, nullable]] of Object.entries(paymentEffectFields)) {
      if (type === 'datetime') {
        check(nullable || source[field] !== null, 'payment_effect_time_required')
        times[field] = inspectWallClock(source[field])
      } else represent(source[field], type, nullable)
    }
    check(BigInt(source.id) > 0n && !ids.has(source.id), 'payment_effect_identity_invalid'); ids.add(source.id)
    check(!externalIds.has(source.order_id), 'payment_effect_duplicate_order'); externalIds.add(source.order_id)
    const add = code => blockers.push({ sourceId: source.id, code })
    const matches = orders.filter(order => order.order_id === source.order_id)
    const order = matches.length === 1 ? matches[0] : null
    if (!order) add('exact_paid_order_missing')
    else {
      if (order.user_id !== source.user_id) add('order_user_mismatch')
      if (order.status !== 'paid') add('order_not_paid')
    }
    if (BigInt(source.attempt_count) < 0n) add('negative_attempt_count')
    if (!['pending', 'retry', 'processing', 'completed'].includes(source.status)) add('unknown_effect_status')
    if (source.status === 'completed' && (source.completed_at === null || source.locked_at !== null)) add('completion_state_inconsistent')
    if (source.status === 'processing' && source.locked_at === null) add('processing_lock_missing')
    if (['pending', 'retry', 'processing'].includes(source.status)) add('unfinished_delivery_reconciliation_required')
    add('historical_time_basis_required')
    entries.push({ sourceId: source.id, sourceHash: hash(source), source: { ...source }, times, orderSourceId: order?.id ?? null,
      disposition: source.status === 'completed' ? 'completed_post_payment_delivery' : 'unresolved_post_payment_delivery',
      membershipActivationProven: false, enqueueOutbox: false, grantEntitlement: false, replayCommission: false, resendNotification: false })
  }
  entries.sort((a, b) => BigInt(a.sourceId) < BigInt(b.sourceId) ? -1 : 1)
  blockers.sort((a, b) => BigInt(a.sourceId) < BigInt(b.sourceId) ? -1 : BigInt(a.sourceId) > BigInt(b.sourceId) ? 1 : a.code.localeCompare(b.code))
  return { version: 'payment-effects-source/v1', sourceHash: hash(entries.map(entry => entry.source)), entries, blockers, businessWritesEnabled: false }
}
