import { MysqlBackfillRepository } from './v4-backfill-mysql-repository.mjs'
import { canonical, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { verifyInplaceJournal } from './mysql-inplace-column-store.mjs'
import { coordinateInplaceSchema } from './inplace-schema-coordinator.mjs'
import { loadLearningCoreCoordinator } from './inplace-learning-core-schema.mjs'

const root = new URL('../../', import.meta.url)
export async function readLearningCourseTargetIdentity(connection) {
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === 'dev_vue' || /^dev_vue_m1_source_\d{8}_\d{2}$/.test(identity.db), 'backfill_learning_database_invalid')
  check(await verifyInplaceJournal(connection), 'backfill_learning_journal_required')
  const plan = await loadLearningCoreCoordinator(root)
  const result = await coordinateInplaceSchema(plan.store(connection), plan)
  check(result.structureComplete && result.steps.every(step => step.status === 'completed'), 'backfill_learning_schema_incomplete')
  const [[source]] = await connection.query('SHOW CREATE TABLE `courses`')
  const storageMode = 'inplace-learning-course-v1'
  return { serverUuid: identity.uuid, database: identity.db, storageMode,
    schemaHash: hash({ adapterVersion: 'learning-course/v1', storageMode, source: tableDefinitionHash(source['Create Table']),
      steps: plan.steps.map(({ id, checksum }) => ({ id, checksum })) }) }
}

export class MysqlLearningCourseBackfillRepository extends MysqlBackfillRepository {
  constructor(pool, sourceEvidence) {
    // Pool sessions can be reused after callers changed isolation. Pin it before
    // BEGIN so the final source/target/archive audit observes one stable snapshot.
    super({ async getConnection() {
      const connection = await pool.getConnection()
      try { await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ') }
      catch (error) { connection.destroy(); throw error }
      return connection
    } })
    check(typeof sourceEvidence === 'function', 'backfill_learning_evidence_required')
    this.sourceEvidence = sourceEvidence
  }
  transaction(work) {
    return super.transaction(tx => {
      tx.targetIdentity = () => readLearningCourseTargetIdentity(tx.connection)
      const insertReceipt = tx.insertReceipt.bind(tx)
      tx.insertReceipt = async (run, stream, batch, row) => {
        check(run === row.payload.entry.targets.course.migration_run_id && run === row.payload.run.id, 'backfill_learning_run_mismatch')
        const payload = await this.sourceEvidence(tx.connection, stream, row), pkHash = hash(row.pk)
        await insertReceipt(run, stream, batch, row)
        await tx.connection.execute('INSERT INTO data_migration_source_rows (run_id,stream_id,source_pk_sha256,source_bytes_sha256,source_payload_json,created_at_utc) VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))',
          [run, stream, pkHash, row.sourceHash, canonical(payload)])
        const [[saved]] = await tx.connection.execute('SELECT source_bytes_sha256,source_payload_json FROM data_migration_source_rows WHERE run_id=? AND stream_id=? AND source_pk_sha256=? FOR UPDATE', [run, stream, pkHash])
        const actual = typeof saved?.source_payload_json === 'string' ? JSON.parse(saved.source_payload_json) : saved?.source_payload_json
        check(saved?.source_bytes_sha256 === row.sourceHash && canonical(actual) === canonical(payload), 'backfill_learning_evidence_readback')
      }
      return work(tx)
    })
  }
}
