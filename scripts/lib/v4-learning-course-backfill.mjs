import { canonical, hash, streamIdentity, requireBackfill as check } from './v4-backfill-contract.mjs'
import { createLearningCourseWriter } from './mysql-learning-course-writer.mjs'

const pk = value => [{ type: 'integer', value }]
export function createLearningCourseBackfill(rows, options, { batchSize = 100 } = {}) {
  check(Number.isInteger(batchSize) && batchSize > 0 && batchSize <= 500, 'learning_course_batch_size')
  options = structuredClone(options)
  const inner = createLearningCourseWriter(rows, options), stream = { sourceTable: 'courses', role: 'learning-course-v1' }
  const transformHash = hash({ version: 'learning-course-backfill/v1', conversion: inner.prepared.transformHash })
  const prepared = inner.prepared.entries.map(entry => {
    const targets = [{ table: 'learning_courses', pk: pk(entry.sourceId) }, { table: 'learning_lessons', pk: pk(entry.sourceId) }]
    const payload = { entry, run: options.run }
    return { pk: pk(entry.sourceId), sourceHash: entry.sourceHash, targets, payload, transformedHash: hash({ payload, targets }),
      idMaps: targets.map((target, index) => ({ entityKind: index === 0 ? 'learning-course' : 'learning-lesson', sourceTable: 'courses', sourcePk: pk(entry.sourceId), target })) }
  })
  const expected = new Map(prepared.map(row => [canonical(row.pk), canonical(row)])), batches = []
  const validate = row => check(expected.get(canonical(row.pk)) === canonical(row), 'learning_course_batch_row_changed')
  let cursor = null
  for (let offset = 0; offset < prepared.length; offset += batchSize) {
    const members = prepared.slice(offset, offset + batchSize)
    const content = { stream, sequence: batches.length + 1, startCursor: cursor, endCursor: members.at(-1).pk, rows: members }
    const batch = { batchId: hash({ transformHash, content }), ...content }
    check(Buffer.byteLength(canonical(batch)) <= 2 * 1024 * 1024, 'backfill_byte_limit')
    batches.push(batch); cursor = content.endCursor
  }
  const writer = { storageMode: 'inplace-learning-course-v1', transformHash, async write(connection, row) {
    validate(row)
    await inner.write(connection, row.payload.entry)
    return { transformedHash: row.transformedHash }
  } }
  // Generated media IDs cannot enter the pre-commit batch hash. Store their
  // exact source-kind -> primary-key bindings in the same transaction archive.
  // Read and verify all three tables again; never trust insertId or a JS cache.
  const sourceEvidence = async (connection, streamId, row) => {
    check(streamId === streamIdentity(stream), 'learning_course_evidence_stream')
    validate(row)
    const entry = row.payload.entry, verified = await inner.write(connection, entry, { verifyOnly: true })
    return structuredClone({ version: 1, sourceTable: 'courses', projection: 'learning-course-source/v1', source: entry.provenance.source,
      sourceSnapshotId: options.run.sourceSnapshotId, registeredAtUtc: options.run.registeredAtUtc,
      basisHash: entry.provenance.basisHash, resolution: entry.provenance.resolution,
      mediaBindings: verified.media })
  }
  return { batches: structuredClone(batches), writer, sourceEvidence, stream, transformHash, sourceHash: inner.prepared.sourceHash,
    sourceRows: prepared.length, runId: options.run.id, lessonMappings: structuredClone(inner.prepared.lessonMappings), businessWritesPerformed: false }
}
