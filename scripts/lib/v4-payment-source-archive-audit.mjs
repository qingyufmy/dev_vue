import { canonical, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { inspectPaymentOrderSources, paymentOrderFields } from './v4-payment-order-source.mjs'
import { inspectPaymentWatches, paymentWatchFields } from './v4-payment-watch-source.mjs'

// Independent of target converters: compare the captured source bytes represented
// as canonical JSON. Decimal spellings, NULL and raw wall clocks remain distinct.
export function auditPaymentSourceArchives({ orders, watches, userIds, sessionOffset, sourceSnapshotId,
  orderRunId, matchRunId, orderArchives, matchArchives }) {
  const sourceOrders = inspectPaymentOrderSources(orders, userIds)
  const sourceWatches = inspectPaymentWatches(watches, orders, { sessionOffset })
  check(typeof sourceSnapshotId === 'string' && sourceSnapshotId.length > 0, 'payment_archive_snapshot_required')
  const differences = []
  const add = (table, sourceId, code, field = null) => differences.push({ table, sourceId, code, field })
  const byOrder = new Map(orders.map(row => [row.id, row]))
  function audit(entries, archives, table, projection, runId, fields) {
    check(Array.isArray(archives) && typeof runId === 'string' && runId.length > 0, 'payment_archive_scope_invalid')
    const saved = new Map()
    for (const archive of archives) {
      check(typeof archive.sourceId === 'string' && !saved.has(archive.sourceId), 'payment_archive_duplicate_source')
      saved.set(archive.sourceId, archive)
    }
    for (const entry of entries) {
      const record = saved.get(entry.sourceId)
      if (!record) { add(table, entry.sourceId, 'missing'); continue }
      saved.delete(entry.sourceId)
      const payload = record.payload
      if (record.runId !== runId || record.sourceHash !== entry.sourceHash
        || record.sourcePkHash !== hash([{ type: 'integer', value: entry.sourceId }])) add(table, entry.sourceId, 'identity_or_hash_mismatch')
      if (!payload || payload.version !== 1 || payload.sourceTable !== table || payload.projection !== projection
        || payload.sourceSnapshotId !== sourceSnapshotId) { add(table, entry.sourceId, 'payload_scope_mismatch'); continue }
      if (!payload.source || Object.keys(payload.source).sort().join('|') !== [...fields].sort().join('|')) {
        add(table, entry.sourceId, 'source_shape_mismatch'); continue
      }
      for (const field of fields) if (canonical(payload.source[field]) !== canonical(entry.source[field])) add(table, entry.sourceId, 'source_value_mismatch', field)
      if (hash(payload.source) !== record.sourceHash) add(table, entry.sourceId, 'stored_source_hash_mismatch')
      if (table === 'crypto_watch_list') {
        const parent = byOrder.get(entry.orderSourceId)
        if (!parent || canonical(payload.orderSource ?? null) !== canonical(parent)) add(table, entry.sourceId, 'parent_source_mismatch')
        if (payload.parentRun?.id !== orderRunId || payload.parentRun?.sourceSnapshotId !== sourceSnapshotId) add(table, entry.sourceId, 'parent_run_mismatch')
      }
    }
    for (const sourceId of saved.keys()) add(table, sourceId, 'unexpected')
  }
  audit(sourceOrders.entries, orderArchives, 'orders', 'payment-order-source/v1', orderRunId, Object.keys(paymentOrderFields))
  audit(sourceWatches.entries, matchArchives, 'crypto_watch_list', 'payment-match-source/v1', matchRunId, Object.keys(paymentWatchFields))
  const sourceBlockers = [...sourceOrders.blockers.map(item => ({ table: 'orders', ...item })),
    ...sourceWatches.blockers.map(item => ({ table: 'crypto_watch_list', ...item })),
    ...sourceWatches.orderBlockers.map(item => ({ table: 'orders', ...item }))]
  return { version: 'payment-source-archive-audit/v1', orders: orders.length, watches: watches.length,
    orderFields: Object.keys(paymentOrderFields).length, watchFields: Object.keys(paymentWatchFields).length,
    sourceValuesPreserved: differences.length === 0, differences, sourceBlockers,
    ordersWithoutWatch: sourceWatches.ordersWithoutWatch,
    // An order and its watch can have different confirmation observations. The
    // two original fields are preserved independently, never added or overwritten.
    confirmationSnapshots: sourceWatches.entries.filter(entry => entry.orderSourceId !== null).map(entry => ({
      orderSourceId: entry.orderSourceId, watchSourceId: entry.sourceId,
      orderConfirmations: byOrder.get(entry.orderSourceId).crypto_confirmations, watchConfirmations: entry.source.confirmations })),
    targetBusinessFactsVerified: false, historicalTimeValidated: false, deletionAuthorized: false, fullPaymentConverted: false }
}
