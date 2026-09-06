import { exactKeys, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { representIdentityValue as represent } from './v4-identity-values.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'

export const paymentWatchFields = Object.freeze({ id: ['int', false], order_id: ['varchar(36)', false], user_id: ['int', false],
  chain: ['varchar(10)', false], address: ['varchar(100)', false], expected_amount: ['decimal(20,8)', false],
  status: ['varchar(20)', true], tx_hash: ['varchar(100)', true], confirmations: ['int', true],
  required_confirmations: ['int', true], wallet_index: ['int', true], created_at: ['timestamp', true], expires_at: ['datetime', false] })

// created_at must be fetched with a verified UTC MySQL session. expires_at is
// DATETIME and remains unresolved even though it is fetched in that same session.
export function inspectPaymentWatches(rows, orders, { sessionOffset } = {}) {
  check(sessionOffset === '+00:00', 'payment_watch_utc_session_required')
  check(Array.isArray(rows) && Array.isArray(orders), 'payment_watch_scope_invalid')
  const seen = new Set(), entries = [], blockers = [], watchesByOrder = new Map(), hashes = new Map()
  const orderIds = new Set()
  for (const order of orders) {
    check(typeof order.id === 'string' && !orderIds.has(order.id), 'payment_watch_order_identity_invalid')
    orderIds.add(order.id)
  }
  for (const source of rows) {
    exactKeys(source, Object.keys(paymentWatchFields))
    const values = {}
    for (const [key, [type, nullable]] of Object.entries(paymentWatchFields)) {
      if (['timestamp', 'datetime'].includes(type)) {
        check(nullable || source[key] !== null, 'payment_watch_time_required')
        values[key] = inspectWallClock(source[key])
      } else values[key] = represent(source[key], type, nullable)
    }
    check(BigInt(source.id) > 0n && !seen.has(source.id), 'payment_watch_identity_invalid'); seen.add(source.id)
    const add = code => blockers.push({ sourceId: source.id, code })
    const matches = orders.filter(order => order.order_id === source.order_id)
    if (matches.length !== 1) add(matches.length ? 'ambiguous_order' : 'exact_order_missing')
    const order = matches.length === 1 ? matches[0] : null
    if (order) {
      watchesByOrder.set(order.id, [...(watchesByOrder.get(order.id) ?? []), source.id])
      if (source.user_id !== order.user_id) add('order_user_mismatch')
      for (const [watchField, orderField] of [['chain', 'crypto_chain'], ['address', 'crypto_address'], ['tx_hash', 'crypto_tx_hash']]) {
        if (source[watchField] !== order[orderField]) add(`${watchField}_mismatch`)
      }
      const expected = represent(order.crypto_amount, 'decimal(20,8)', true)
      if (values.expected_amount !== expected) add('expected_amount_mismatch')
      if (values.expires_at.canonicalWallClock !== inspectWallClock(order.crypto_expires_at).canonicalWallClock) add('expiry_mismatch')
      const allowed = { pending: ['pending'], confirming: ['pending'], confirmed: ['paid'], expired: ['expired'], cancelled: ['cancelled'] }
      if (!allowed[source.status]?.includes(order.status)) add('order_watch_status_mismatch')
    }
    if (!['pending', 'confirming', 'confirmed', 'expired', 'cancelled'].includes(source.status)) add('unknown_watch_status')
    if (BigInt(values.expected_amount.replace('.', '')) <= 0n) add('nonpositive_expected_amount')
    for (const field of ['confirmations', 'required_confirmations', 'wallet_index']) {
      if (values[field] !== null && BigInt(values[field]) < 0n) add(`negative_${field}`)
    }
    if (source.required_confirmations === null || BigInt(source.required_confirmations) <= 0n) add('confirmation_policy_unproven')
    if (['confirming', 'confirmed'].includes(source.status) && !source.tx_hash) add('transaction_hash_missing')
    if (source.status === 'confirmed' && (source.confirmations === null || source.required_confirmations === null ||
      BigInt(source.confirmations) < BigInt(source.required_confirmations))) add('confirmation_threshold_unproven')
    if (source.tx_hash !== null) hashes.set(source.tx_hash, [...(hashes.get(source.tx_hash) ?? []), source.id])
    add('expiry_time_basis_required')
    entries.push({ sourceId: source.id, sourceHash: hash(source), source: { ...source }, orderSourceId: order?.id ?? null,
      createdAtUtc: values.created_at.canonicalWallClock, expiresAtWallClock: source.expires_at, expiresAtUtc: null,
      expectedAmount: values.expected_amount, createsTransaction: false, activatesWatch: false })
  }
  for (const ids of watchesByOrder.values()) if (ids.length > 1) for (const id of ids) blockers.push({ sourceId: id, code: 'multiple_watches_for_order' })
  for (const ids of hashes.values()) if (ids.length > 1) for (const id of ids) blockers.push({ sourceId: id, code: 'duplicate_transaction_hash' })
  entries.sort((a, b) => BigInt(a.sourceId) < BigInt(b.sourceId) ? -1 : 1)
  blockers.sort((a, b) => BigInt(a.sourceId) < BigInt(b.sourceId) ? -1 : BigInt(a.sourceId) > BigInt(b.sourceId) ? 1 : a.code.localeCompare(b.code))
  return { version: 'payment-watch-source/v1', sourceHash: hash(entries.map(e => e.source)), entries, blockers,
    ordersWithoutWatch: orders.filter(order => !watchesByOrder.has(order.id)).map(order => order.id),
    orderBlockers: orders.filter(order => !watchesByOrder.has(order.id) && order.status === 'pending')
      .map(order => ({ sourceId: order.id, code: 'pending_order_watch_missing' })),
    businessWritesEnabled: false, fullPaymentConverted: false }
}
