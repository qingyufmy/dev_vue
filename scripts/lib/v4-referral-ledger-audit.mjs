import { canonical, hash, streamIdentity, requireBackfill as check } from './v4-backfill-contract.mjs'
import { validateSpec } from './v4-referral-backfill-contract.mjs'

const decode = value => typeof value === 'string' ? JSON.parse(value) : value
// Read independently from the writer and its acknowledgements; never repair mismatches.
export async function auditReferralLedger(connection, spec, prepared) {
  validateSpec(spec)
  check(prepared.transformHash === spec.bindings.transformHash
    && canonical(spec.bindings.streams) === canonical([prepared.stream]), 'referral_audit_manifest_mismatch')
  const stream = streamIdentity(prepared.stream), bindings = spec.bindings
  const [runs] = await connection.execute('SELECT bindings_sha256,bindings_json FROM data_migration_runs WHERE id=?', [spec.runId])
  check(runs.length === 1 && runs[0].bindings_sha256 === hash(bindings)
    && canonical(decode(runs[0].bindings_json)) === canonical(bindings), 'referral_audit_run_mismatch')
  const [checkpoints] = await connection.execute('SELECT stream_id,sequence_number,cursor_json,processed_rows FROM data_migration_checkpoints WHERE run_id=?', [spec.runId])
  const last = prepared.batches.at(-1)
  check(checkpoints.length === 1 && checkpoints[0].stream_id === stream
    && String(checkpoints[0].sequence_number) === String(prepared.batches.length)
    && String(checkpoints[0].processed_rows) === String(prepared.sourceRows)
    && canonical(decode(checkpoints[0].cursor_json)) === canonical(last?.endCursor ?? null), 'referral_audit_checkpoint_mismatch')
  const [batches] = await connection.execute('SELECT batch_id,stream_id,sequence_number,request_sha256,row_count,end_cursor_json FROM data_migration_batches WHERE run_id=? ORDER BY sequence_number', [spec.runId])
  check(batches.length === prepared.batches.length, 'referral_audit_batch_count')
  for (let i = 0; i < batches.length; i++) {
    const actual = batches[i], expected = prepared.batches[i]
    check(actual.batch_id === expected.batchId && actual.stream_id === stream && String(actual.sequence_number) === String(expected.sequence)
      && actual.request_sha256 === hash(expected) && String(actual.row_count) === String(expected.rows.length)
      && canonical(decode(actual.end_cursor_json)) === canonical(expected.endCursor), 'referral_audit_batch_mismatch')
  }
  const [mappings] = await connection.execute('SELECT logical_source_id,entity_kind,source_table,source_pk_sha256,source_pk_json,target_json,created_run_id FROM data_migration_id_maps WHERE logical_source_id=? OR created_run_id=?', [bindings.logicalSourceId, spec.runId])
  const expectedMaps = prepared.batches.flatMap(batch => batch.rows.flatMap(row => row.idMaps))
  check(mappings.length === expectedMaps.length, 'referral_audit_mapping_count')
  const matched = new Set()
  for (const expected of expectedMaps) {
    const candidates = mappings.filter(m => m.entity_kind === expected.entityKind && m.source_table === expected.sourceTable && m.source_pk_sha256 === hash(expected.sourcePk))
    check(candidates.length === 1, 'referral_audit_mapping_missing')
    const actual = candidates[0]
    check(!matched.has(actual) && actual.logical_source_id === bindings.logicalSourceId && actual.created_run_id === spec.runId
      && canonical(decode(actual.source_pk_json)) === canonical(expected.sourcePk)
      && canonical(decode(actual.target_json)) === canonical(expected.target), 'referral_audit_mapping_mismatch')
    matched.add(actual)
  }
  return { runVerified: true, checkpointsVerified: checkpoints.length, batchesVerified: batches.length,
    mappingsVerified: mappings.length, processedRows: prepared.sourceRows, databaseWrites: 0 }
}
