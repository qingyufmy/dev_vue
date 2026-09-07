import { canonical, hash, streamIdentity, requireBackfill as check } from './v4-backfill-contract.mjs'

const decode = value => {
  try { return typeof value === 'string' ? JSON.parse(value) : value }
  catch { check(false, 'learning_control_json_invalid') }
}
// Run inside the same fresh snapshot as the business audit. A batch marker alone
// does not prove its row receipts, mappings and final checkpoint still exist.
export async function verifyLearningMigrationControl(connection, spec, pipeline) {
  const stream = streamIdentity(pipeline.stream)
  check(spec.runId === pipeline.runId && spec.bindings.transformHash === pipeline.transformHash
    && ['courses', 'progress'].includes(pipeline.stream.sourceTable), 'learning_control_binding')
  const [batches] = await connection.execute(`SELECT batch_id,stream_id,CAST(sequence_number AS CHAR) sequence_number,request_sha256,
    CAST(row_count AS CHAR) row_count,end_cursor_json FROM data_migration_batches WHERE run_id=? ORDER BY batch_id`, [spec.runId])
  const [receipts] = await connection.execute(`SELECT stream_id,source_pk_sha256,batch_id,source_pk_json,source_bytes_sha256,transformed_sha256,targets_json
    FROM data_migration_row_receipts WHERE run_id=? ORDER BY stream_id,source_pk_sha256`, [spec.runId])
  const [checkpoints] = await connection.execute(`SELECT stream_id,CAST(sequence_number AS CHAR) sequence_number,cursor_json,CAST(processed_rows AS CHAR) processed_rows
    FROM data_migration_checkpoints WHERE run_id=? ORDER BY stream_id`, [spec.runId])
  const [maps] = await connection.execute(`SELECT logical_source_id,entity_kind,source_table,source_pk_sha256,source_pk_json,target_json
    FROM data_migration_id_maps WHERE (logical_source_id=? AND source_table=?) OR created_run_id=?
    ORDER BY logical_source_id,entity_kind,source_table,source_pk_sha256`, [spec.bindings.logicalSourceId, pipeline.stream.sourceTable, spec.runId])
  const normalize = (rows, jsonFields) => rows.map(row => Object.fromEntries(Object.entries(row).map(([field, value]) => [field, jsonFields.includes(field) ? decode(value) : value])))
  const compare = (actual, expected, code) => {
    const order = rows => rows.map(canonical).sort()
    check(canonical(order(actual)) === canonical(order(expected)), code)
  }
  compare(normalize(batches, ['end_cursor_json']), pipeline.batches.map(batch => ({ batch_id: batch.batchId, stream_id: stream,
    sequence_number: String(batch.sequence), request_sha256: hash(batch), row_count: String(batch.rows.length), end_cursor_json: batch.endCursor })), 'learning_control_batches_mismatch')
  compare(normalize(receipts, ['source_pk_json', 'targets_json']), pipeline.batches.flatMap(batch => batch.rows.map(row => ({ stream_id: stream,
    source_pk_sha256: hash(row.pk), batch_id: batch.batchId, source_pk_json: row.pk, source_bytes_sha256: row.sourceHash,
    transformed_sha256: row.transformedHash, targets_json: row.targets }))), 'learning_control_receipts_mismatch')
  compare(normalize(checkpoints, ['cursor_json']), [{ stream_id: stream, sequence_number: String(pipeline.batches.length),
    cursor_json: pipeline.batches.at(-1)?.endCursor ?? null, processed_rows: String(pipeline.sourceRows) }], 'learning_control_checkpoint_mismatch')
  compare(normalize(maps, ['source_pk_json', 'target_json']), pipeline.batches.flatMap(batch => batch.rows.flatMap(row => row.idMaps.map(mapping => ({
    logical_source_id: spec.bindings.logicalSourceId, entity_kind: mapping.entityKind, source_table: mapping.sourceTable,
    source_pk_sha256: hash(mapping.sourcePk), source_pk_json: mapping.sourcePk, target_json: mapping.target })))), 'learning_control_maps_mismatch')
  return { version: 'learning-control-audit/v1', verified: true, batches: batches.length, receipts: receipts.length, checkpoints: checkpoints.length, mappings: maps.length }
}
