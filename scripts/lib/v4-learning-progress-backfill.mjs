import { canonical, hash, streamIdentity, requireBackfill as check } from './v4-backfill-contract.mjs'
import { createLearningProgressWriter } from './mysql-learning-progress-writer.mjs'

const pk = value => [{ type: 'integer', value }]
// Closed batches for the existing receipt/checkpoint protocol. A learning-scoped
// repository and runner must validate their storage binding before execution.
export function createLearningProgressBackfill(rows, options, { batchSize = 100 } = {}) {
  check(Number.isInteger(batchSize) && batchSize > 0 && batchSize <= 500, 'learning_progress_batch_size')
  options = structuredClone(options)
  const inner = createLearningProgressWriter(rows, options), stream = { sourceTable: 'progress', role: 'learning-progress-v1' }
  const transformHash = hash({ version: 'learning-progress-backfill/v1', conversion: inner.prepared.transformHash })
  const prepared = inner.prepared.entries.map(entry => {
    const target = { table: 'learning_progress', pk: pk(entry.target.id) }, targets = [target]
    const payload = { entry, run: options.run }
    return { pk: pk(entry.sourceId), sourceHash: entry.sourceHash, targets, payload, transformedHash: hash({ payload, targets }),
      idMaps: [{ entityKind: 'learning-progress', sourceTable: 'progress', sourcePk: pk(entry.sourceId), target }] }
  })
  const expected = new Map(prepared.map(row => [canonical(row.pk), canonical(row)])), batches = []
  const validate = row => check(expected.get(canonical(row.pk)) === canonical(row), 'learning_progress_batch_row_changed')
  let cursor = null
  for (let offset = 0; offset < prepared.length; offset += batchSize) {
    const members = prepared.slice(offset, offset + batchSize)
    const content = { stream, sequence: batches.length + 1, startCursor: cursor, endCursor: members.at(-1).pk, rows: members }
    const batch = { batchId: hash({ transformHash, content }), ...content }
    check(Buffer.byteLength(canonical(batch)) <= 2 * 1024 * 1024, 'backfill_byte_limit')
    batches.push(batch); cursor = content.endCursor
  }
  const writer = { storageMode: 'inplace-learning-progress-v1', transformHash, async write(connection, row) {
    validate(row)
    await inner.write(connection, row.payload.entry)
    return { transformedHash: row.transformedHash }
  } }
  const sourceEvidence = (streamId, row) => {
    check(streamId === streamIdentity(stream), 'learning_progress_evidence_stream')
    validate(row)
    const entry = row.payload.entry
    return structuredClone({ version: 1, sourceTable: 'progress', projection: 'learning-progress-source/v1', source: entry.provenance.source,
      sourceSnapshotId: row.payload.run.sourceSnapshotId, registeredAtUtc: row.payload.run.registeredAtUtc,
      basisHash: entry.provenance.basisHash, lessonMapping: entry.provenance.lessonMapping, resolution: entry.provenance.resolution })
  }
  return { batches: structuredClone(batches), writer, sourceEvidence, stream, transformHash, sourceHash: inner.prepared.sourceHash,
    sourceRows: prepared.length, runId: options.run.id, businessWritesPerformed: false }
}
