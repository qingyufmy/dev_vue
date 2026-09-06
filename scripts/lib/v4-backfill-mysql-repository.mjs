import { BackfillError, canonical, hash, requireBackfill as check } from './v4-backfill-contract.mjs'

const decode = value => typeof value === 'string' ? JSON.parse(value) : value
const safeInteger = value => { const n = Number(value); check(Number.isSafeInteger(n) && n >= 0, 'backfill_counter_invalid'); return n }

// Journal fingerprint: the physical source/target schema is verified separately by the approved preflight.
export async function readBackfillTargetIdentity(connection) {
  const [[identity]] = await connection.query('SELECT DATABASE() AS db, @@server_uuid AS server_uuid')
  const [migrations] = await connection.query('SELECT id,checksum_sha256,status,statement_count,completed_statements FROM schema_migrations ORDER BY id')
  check(migrations.length > 0 && migrations.every(m => m.status === 'completed' && Number(m.statement_count) === Number(m.completed_statements)), 'backfill_schema_not_complete')
  const [events] = await connection.query('SELECT migration_id,kind,artifact_id,artifact_sha256,details_json FROM schema_migration_events ORDER BY migration_id,id')
  return { serverUuid: identity.server_uuid, database: identity.db, schemaHash: hash({ migrations, events }) }
}

export class MysqlBackfillRepository {
  constructor(pool) { this.pool = pool }
  async transaction(work) {
    let connection
    try { connection = await this.pool.getConnection() }
    catch { throw new BackfillError('backfill_storage_failed') }
    let committing = false
    let destroyed = false
    try {
      await connection.query("SET SESSION time_zone='+00:00'")
      await connection.query('SET SESSION innodb_lock_wait_timeout=10')
      await connection.beginTransaction()
      const result = await work(new MysqlBackfillTransaction(connection))
      committing = true
      await connection.commit()
      return result
    } catch (error) {
      if (committing) {
        destroyed = true
        connection.destroy()
        throw new BackfillError('backfill_commit_unknown')
      }
      try { await connection.rollback() }
      catch {
        destroyed = true
        connection.destroy()
        throw new BackfillError('backfill_rollback_unknown')
      }
      if (error?.code === 'ER_LOCK_DEADLOCK') throw new BackfillError('backfill_deadlock_rolled_back')
      if (error instanceof BackfillError) throw error
      throw new BackfillError('backfill_storage_failed')
    } finally { if (!destroyed) connection.release() }
  }
}

class MysqlBackfillTransaction {
  constructor(connection) { this.connection = connection }
  targetIdentity() { return readBackfillTargetIdentity(this.connection) }
  async findRun(id) {
    const [rows] = await this.connection.execute('SELECT bindings_sha256,bindings_json FROM data_migration_runs WHERE id=? FOR UPDATE', [id])
    return rows[0] ? { bindingsHash: rows[0].bindings_sha256, bindings: decode(rows[0].bindings_json) } : null
  }
  async insertRun(id, bindings, fingerprint) {
    await this.connection.execute('INSERT INTO data_migration_runs (id,bindings_sha256,bindings_json,created_at_utc) VALUES (?,?,?,UTC_TIMESTAMP(3))', [id, fingerprint, canonical(bindings)])
  }
  async insertCheckpoint(run, stream) {
    await this.connection.execute('INSERT INTO data_migration_checkpoints (run_id,stream_id,sequence_number,cursor_json,processed_rows,updated_at_utc) VALUES (?,?,0,NULL,0,UTC_TIMESTAMP(3))', [run, stream])
  }
  async findCheckpoint(run, stream) {
    const [rows] = await this.connection.execute('SELECT sequence_number,cursor_json,processed_rows FROM data_migration_checkpoints WHERE run_id=? AND stream_id=? FOR UPDATE', [run, stream])
    return rows[0] ? { sequence: safeInteger(rows[0].sequence_number), cursor: decode(rows[0].cursor_json), processedRows: String(rows[0].processed_rows) } : null
  }
  async findBatch(run, batch) {
    const [rows] = await this.connection.execute('SELECT batch_id,sequence_number,request_sha256,row_count FROM data_migration_batches WHERE run_id=? AND batch_id=? FOR UPDATE', [run, batch])
    return rows[0] ? { batchId: rows[0].batch_id, sequence: safeInteger(rows[0].sequence_number), requestHash: rows[0].request_sha256, rows: safeInteger(rows[0].row_count) } : null
  }
  async insertBatch(run, batch) {
    await this.connection.execute('INSERT INTO data_migration_batches (run_id,batch_id,stream_id,sequence_number,request_sha256,row_count,end_cursor_json,recorded_at_utc) VALUES (?,?,?,?,?,?,?,UTC_TIMESTAMP(3))', [run, batch.batchId, batch.streamId, batch.sequence, batch.requestHash, batch.rows, canonical(batch.endCursor)])
  }
  async findMapping(logicalSource, mapping) {
    const [rows] = await this.connection.execute('SELECT source_pk_json,target_json FROM data_migration_id_maps WHERE logical_source_id=? AND entity_kind=? AND source_table=? AND source_pk_sha256=? FOR UPDATE', [logicalSource, mapping.entityKind, mapping.sourceTable, hash(mapping.sourcePk)])
    return rows[0] ? { sourcePk: decode(rows[0].source_pk_json), target: decode(rows[0].target_json) } : null
  }
  async insertMapping(run, logicalSource, mapping) {
    await this.connection.execute('INSERT INTO data_migration_id_maps (logical_source_id,entity_kind,source_table,source_pk_sha256,source_pk_json,target_json,created_run_id,created_at_utc) VALUES (?,?,?,?,?,?,?,UTC_TIMESTAMP(3))', [logicalSource, mapping.entityKind, mapping.sourceTable, hash(mapping.sourcePk), canonical(mapping.sourcePk), canonical(mapping.target), run])
  }
  async findReceipt(run, stream, pkHash) {
    const [rows] = await this.connection.execute('SELECT batch_id FROM data_migration_row_receipts WHERE run_id=? AND stream_id=? AND source_pk_sha256=? FOR UPDATE', [run, stream, pkHash])
    return rows[0] ?? null
  }
  async insertReceipt(run, stream, batch, row) {
    await this.connection.execute('INSERT INTO data_migration_row_receipts (run_id,stream_id,source_pk_sha256,batch_id,source_pk_json,source_bytes_sha256,transformed_sha256,targets_json,created_at_utc) VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))', [run, stream, hash(row.pk), batch, canonical(row.pk), row.sourceHash, row.transformedHash, canonical(row.targets)])
  }
  async advanceCheckpoint(run, stream, previous, sequence, cursor, total) {
    const [result] = await this.connection.execute('UPDATE data_migration_checkpoints SET sequence_number=?,cursor_json=?,processed_rows=?,updated_at_utc=UTC_TIMESTAMP(3) WHERE run_id=? AND stream_id=? AND sequence_number=?', [sequence, canonical(cursor), total, run, stream, previous])
    check(result.affectedRows === 1, 'backfill_checkpoint_conflict')
  }
}
