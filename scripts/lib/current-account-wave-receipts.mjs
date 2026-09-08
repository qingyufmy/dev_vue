import assert from 'node:assert/strict'
import { hash, canonical, streamIdentity } from './v4-backfill-contract.mjs'
import { sourceEvidencePayload } from './v4-source-row-evidence.mjs'

// Read-only reconciliation of the already committed fixed account wave.
export async function verifyCurrentAccountWaveReceipts(connection, prepared, specs) {
      for (let index = 0; index < prepared.length; index++) {
        const stream = prepared[index], spec = specs[index], sid = streamIdentity(stream.stream)
        const [[run]] = await connection.execute('SELECT bindings_sha256 fingerprint,bindings_json bindings FROM data_migration_runs WHERE id=?', [spec.runId])
        assert.equal(run.fingerprint, hash(spec.bindings)); assert.equal(canonical(JSON.parse(run.bindings)), canonical(spec.bindings))
        for (const batch of stream.batches) for (const row of batch.rows) {
          const [[saved]] = await connection.execute('SELECT batch_id batch,source_bytes_sha256 sourceHash,transformed_sha256 transformedHash,targets_json targets FROM data_migration_row_receipts WHERE run_id=? AND stream_id=? AND source_pk_sha256=?', [spec.runId, sid, hash(row.pk)])
          assert.equal(saved.batch, batch.batchId); assert.equal(saved.sourceHash, row.sourceHash); assert.equal(saved.transformedHash, row.transformedHash)
          assert.equal(canonical(JSON.parse(saved.targets)), canonical(row.targets))
          const [[evidence]] = await connection.execute('SELECT source_bytes_sha256 sourceHash,source_payload_json payload FROM data_migration_source_rows WHERE run_id=? AND stream_id=? AND source_pk_sha256=?', [spec.runId, sid, hash(row.pk)])
          assert.equal(evidence.sourceHash, row.sourceHash); assert.equal(canonical(JSON.parse(evidence.payload)), canonical(sourceEvidencePayload(sid, row)))
          for (const mapping of row.idMaps) {
            const [[savedMap]] = await connection.execute('SELECT source_pk_json sourcePk,target_json target,created_run_id runId FROM data_migration_id_maps WHERE logical_source_id=? AND entity_kind=? AND source_table=? AND source_pk_sha256=?',
              ['dev_vue', mapping.entityKind, mapping.sourceTable, hash(mapping.sourcePk)])
            assert.equal(savedMap.runId, spec.runId)
            assert.equal(canonical(JSON.parse(savedMap.sourcePk)), canonical(mapping.sourcePk))
            assert.equal(canonical(JSON.parse(savedMap.target)), canonical(mapping.target))
          }
        }
        for (const table of ['data_migration_row_receipts', 'data_migration_source_rows']) {
          const [[count]] = await connection.execute(`SELECT COUNT(*) n FROM ${table} WHERE run_id=?`, [spec.runId]); assert.equal(Number(count.n), stream.sourceRows)
        }
        const [[mapCount]] = await connection.execute('SELECT COUNT(*) n FROM data_migration_id_maps WHERE created_run_id=?', [spec.runId])
        assert.equal(Number(mapCount.n), stream.batches.flatMap(batch => batch.rows).reduce((sum, row) => sum + row.idMaps.length, 0))
        const [[checkpoint]] = await connection.execute('SELECT sequence_number sequenceNumber,processed_rows processedRows,cursor_json cursorValue FROM data_migration_checkpoints WHERE run_id=? AND stream_id=?', [spec.runId, sid])
        assert.equal(Number(checkpoint.sequenceNumber), stream.batches.length); assert.equal(Number(checkpoint.processedRows), stream.sourceRows)
        assert.equal(canonical(JSON.parse(checkpoint.cursorValue)), canonical(stream.batches.at(-1).endCursor))
        const [[batchCount]] = await connection.execute('SELECT COUNT(*) n FROM data_migration_batches WHERE run_id=?', [spec.runId])
        assert.equal(Number(batchCount.n), stream.batches.length)
        const [[checkpointCount]] = await connection.execute('SELECT COUNT(*) n FROM data_migration_checkpoints WHERE run_id=?', [spec.runId])
        assert.equal(Number(checkpointCount.n), 1)
      }
}
