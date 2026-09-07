import { canonical, hash, streamIdentity } from '../../scripts/lib/v4-backfill-contract.mjs'
export function learningControlFixture(spec, pipeline) {
  const stream = streamIdentity(pipeline.stream)
  return {
    batches: pipeline.batches.map(batch => ({ batch_id: batch.batchId, stream_id: stream, sequence_number: String(batch.sequence), request_sha256: hash(batch),
      row_count: String(batch.rows.length), end_cursor_json: canonical(batch.endCursor) })),
    receipts: pipeline.batches.flatMap(batch => batch.rows.map(row => ({ stream_id: stream, source_pk_sha256: hash(row.pk), batch_id: batch.batchId,
      source_pk_json: canonical(row.pk), source_bytes_sha256: row.sourceHash, transformed_sha256: row.transformedHash, targets_json: canonical(row.targets) }))),
    checkpoints: [{ stream_id: stream, sequence_number: String(pipeline.batches.length), cursor_json: pipeline.batches.length ? canonical(pipeline.batches.at(-1).endCursor) : null,
      processed_rows: String(pipeline.sourceRows) }],
    maps: pipeline.batches.flatMap(batch => batch.rows.flatMap(row => row.idMaps.map(mapping => ({ logical_source_id: spec.bindings.logicalSourceId,
      entity_kind: mapping.entityKind, source_table: mapping.sourceTable, source_pk_sha256: hash(mapping.sourcePk),
      source_pk_json: canonical(mapping.sourcePk), target_json: canonical(mapping.target) })))),
  }
}
