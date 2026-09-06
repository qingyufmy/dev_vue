import { canonical, hash, streamIdentity, requireBackfill as check } from './v4-backfill-contract.mjs'
import { createPaymentMatchWriter } from './mysql-payment-match-writer.mjs'

const pk = value => [{ type: 'integer', value }]
export function createPaymentMatchBackfill(watches, orders, options, { batchSize = 100 } = {}) {
  check(Number.isInteger(batchSize) && batchSize > 0 && batchSize <= 500, 'payment_match_batch_size_invalid')
  options = structuredClone(options)
  const inner = createPaymentMatchWriter(watches, orders, options)
  const stream = { sourceTable: 'crypto_watch_list', role: 'payment-match-v1' }
  const transformHash = hash({ version: 'payment-match-backfill/v1', conversion: inner.prepared.transformHash,
    parentTimeBasis: options.orderOptions.timeBasis, parentRun: options.orderOptions.run })
  const prepared = inner.prepared.entries.map(entry => {
    const target = { table: 'payment_matches', pk: pk(entry.target.id) }, targets = [target]
    const payload = { entry, run: options.run, parentRun: options.orderOptions.run,
      parentTimeBasisHash: hash(options.orderOptions.timeBasis),
      parentTimeResolutions: options.orderOptions.timeBasis.resolutions.filter(time => time.sourceId === entry.provenance.orderSource.id) }
    return { pk: pk(entry.sourceId), sourceHash: entry.sourceHash, targets, payload, transformedHash: hash({ payload, targets }),
      idMaps: [{ entityKind: 'payment-match', sourceTable: 'crypto_watch_list', sourcePk: pk(entry.sourceId), target }] }
  })
  const expected = new Map(prepared.map(row => [canonical(row.pk), canonical(row)])), batches = []
  const validate = row => check(expected.get(canonical(row.pk)) === canonical(row), 'payment_match_batch_row_changed')
  let cursor = null
  for (let offset = 0; offset < prepared.length; offset += batchSize) {
    const members = prepared.slice(offset, offset + batchSize)
    const content = { stream, sequence: batches.length + 1, startCursor: cursor, endCursor: members.at(-1).pk, rows: members }
    batches.push({ batchId: hash({ transformHash, content }), ...content }); cursor = content.endCursor
  }
  const writer = { storageMode: 'inplace-payment-match-v1', transformHash, async write(connection, row) {
    validate(row)
    await inner.write(connection, row.payload.entry)
    return { transformedHash: row.transformedHash }
  } }
  const sourceEvidence = (streamId, row) => {
    check(streamId === streamIdentity(stream), 'payment_match_evidence_stream')
    validate(row)
    return structuredClone({ version: 1, sourceTable: 'crypto_watch_list', projection: 'payment-match-source/v1',
      ...row.payload.entry.provenance, sourceSnapshotId: row.payload.run.sourceSnapshotId,
      registeredAtUtc: row.payload.run.registeredAtUtc, parentRun: row.payload.parentRun,
      parentTimeBasisHash: row.payload.parentTimeBasisHash, parentTimeResolutions: row.payload.parentTimeResolutions })
  }
  return { batches: structuredClone(batches), writer, sourceEvidence, stream, transformHash, sourceHash: inner.prepared.sourceHash,
    sourceRows: prepared.length, runId: options.run.id, unresolvedDependencies: inner.prepared.unresolvedDependencies,
    businessWritesPerformed: false, activatesWatches: false }
}
