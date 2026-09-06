import { MysqlBackfillRepository } from './v4-backfill-mysql-repository.mjs'
import { canonical, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { verifyInplaceJournal } from './mysql-inplace-column-store.mjs'
import { coordinateInplaceSchema } from './inplace-schema-coordinator.mjs'
import { loadSettingsCoordinator } from './inplace-settings-schema.mjs'

const root = new URL('../../', import.meta.url)
export async function readSettingsTargetIdentity(connection) {
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === 'dev_vue' || /^dev_vue_m1_source_\d{8}_\d{2}$/.test(identity.db), 'backfill_settings_database_invalid')
  check(await verifyInplaceJournal(connection), 'backfill_settings_journal_required')
  const plan = await loadSettingsCoordinator(root)
  const result = await coordinateInplaceSchema(plan.store(connection), plan)
  check(result.steps.every(step => step.status === 'completed'), 'backfill_settings_schema_incomplete')
  const [[source]] = await connection.query('SHOW CREATE TABLE `system_config`')
  const storageMode = 'inplace-settings-v1'
  return { serverUuid: identity.uuid, database: identity.db, storageMode,
    schemaHash: hash({ adapterVersion: 'settings/v1', storageMode, source: tableDefinitionHash(source['Create Table']),
      steps: plan.steps.map(({ id, checksum }) => ({ id, checksum })) }) }
}

// Reuse the existing transaction/commit-unknown behavior. Evidence insertion and
// verification use the exact same connection as the target, mappings and receipts.
export class MysqlSettingsBackfillRepository extends MysqlBackfillRepository {
  constructor(pool, sourceEvidence) {
    super(pool)
    check(typeof sourceEvidence === 'function', 'backfill_settings_evidence_required')
    this.sourceEvidence = sourceEvidence
  }
  transaction(work) {
    return super.transaction(tx => {
      tx.targetIdentity = () => readSettingsTargetIdentity(tx.connection)
      const insertReceipt = tx.insertReceipt.bind(tx)
      tx.insertReceipt = async (run, stream, batch, row) => {
        check(run === row.payload.entry.target.migration_run_id && run === row.payload.run.id, 'backfill_settings_run_mismatch')
        const payload = this.sourceEvidence(stream, row), pkHash = hash(row.pk)
        await insertReceipt(run, stream, batch, row)
        await tx.connection.execute('INSERT INTO data_migration_source_rows (run_id,stream_id,source_pk_sha256,source_bytes_sha256,source_payload_json,created_at_utc) VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))',
          [run, stream, pkHash, row.sourceHash, canonical(payload)])
        const [[saved]] = await tx.connection.execute('SELECT source_bytes_sha256,source_payload_json FROM data_migration_source_rows WHERE run_id=? AND stream_id=? AND source_pk_sha256=? FOR UPDATE', [run, stream, pkHash])
        const actual = typeof saved?.source_payload_json === 'string' ? JSON.parse(saved.source_payload_json) : saved?.source_payload_json
        check(saved?.source_bytes_sha256 === row.sourceHash && canonical(actual) === canonical(payload), 'backfill_settings_evidence_readback')
      }
      return work(tx)
    })
  }
}
