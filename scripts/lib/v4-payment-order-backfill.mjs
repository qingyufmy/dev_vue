import { canonical, hash, streamIdentity, requireBackfill as check } from './v4-backfill-contract.mjs'
import { createPaymentOrderWriter } from './mysql-payment-order-writer.mjs'

const pk = value => [{ type: 'integer', value }]
export function createPaymentOrderBackfill(rows, options, { batchSize = 100 } = {}) {
  check(Number.isInteger(batchSize) && batchSize > 0 && batchSize <= 500, 'payment_order_batch_size_invalid')
  options = structuredClone(options)
  const inner = createPaymentOrderWriter(rows, options), stream = { sourceTable: 'orders', role: 'payment-order-v1' }
  const transformHash = hash({ version: 'payment-order-backfill/v1', conversion: inner.prepared.transformHash })
  const prepared = inner.prepared.entries.map(entry => {
    const target = { table: 'payment_orders', pk: pk(entry.target.id) }, targets = [target]
    const payload = { entry, run: options.run, timeResolutions: options.timeBasis.resolutions.filter(time => time.sourceId === entry.sourceId) }
    return { pk: pk(entry.sourceId), sourceHash: entry.sourceHash, targets, payload, transformedHash: hash({ payload, targets }),
      idMaps: [{ entityKind: 'payment-order', sourceTable: 'orders', sourcePk: pk(entry.sourceId), target }] }
  })
  const expected = new Map(prepared.map(row => [canonical(row.pk), canonical(row)])), batches = []
  const validate = row => check(expected.get(canonical(row.pk)) === canonical(row), 'payment_order_batch_row_changed')
  let cursor = null
  for (let offset = 0; offset < prepared.length; offset += batchSize) {
    const members = prepared.slice(offset, offset + batchSize)
    const content = { stream, sequence: batches.length + 1, startCursor: cursor, endCursor: members.at(-1).pk, rows: members }
    batches.push({ batchId: hash({ transformHash, content }), ...content }); cursor = content.endCursor
  }
  const writer = { storageMode: 'inplace-payment-order-v1', transformHash, async write(connection, row) {
    validate(row)
    await inner.write(connection, row.payload.entry)
    return { transformedHash: row.transformedHash }
  } }
  const sourceEvidence = (streamId, row) => {
    check(streamId === streamIdentity(stream), 'payment_order_evidence_stream')
    validate(row)
    const entry = row.payload.entry
    return structuredClone({ version: 1, sourceTable: 'orders', projection: 'payment-order-source/v1', source: entry.provenance.source,
      sourceSnapshotId: row.payload.run.sourceSnapshotId, registeredAtUtc: row.payload.run.registeredAtUtc,
      timeBasisHash: entry.provenance.timeBasisHash, timeResolutions: row.payload.timeResolutions })
  }
  return { batches: structuredClone(batches), writer, sourceEvidence, stream, transformHash, sourceHash: inner.prepared.sourceHash,
    sourceRows: prepared.length, runId: options.run.id, unresolvedDependencies: inner.prepared.unresolvedDependencies,
    creditBlockers: inner.prepared.creditBlockers, businessWritesPerformed: false }
}
