import { MysqlBackfillRepository } from './v4-backfill-mysql-repository.mjs'
import { canonical, hash, streamIdentity, requireBackfill as check } from './v4-backfill-contract.mjs'
import { convertReferralAccounts } from './v4-referral-conversion.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { verifyInplaceJournal } from './mysql-inplace-column-store.mjs'
import { coordinateInplaceSchema } from './inplace-schema-coordinator.mjs'
import { loadReferralSchemaCoordinator } from './inplace-referral-schema.mjs'

const root = new URL('../../', import.meta.url)
export async function readReferralTargetIdentity(connection) {
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === 'dev_vue' || /^dev_vue_m1_source_\d{8}_\d{2}$/.test(identity.db), 'backfill_referral_database_invalid')
  check(await verifyInplaceJournal(connection), 'backfill_referral_journal_required')
  const plan = await loadReferralSchemaCoordinator(root)
  const result = await coordinateInplaceSchema(plan.store(connection), plan)
  check(result.steps.every(step => step.status === 'completed'), 'backfill_referral_schema_incomplete')
  const [[source]] = await connection.query('SHOW CREATE TABLE `users`')
  const storageMode = 'inplace-referral-v1'
  return { serverUuid: identity.uuid, database: identity.db, storageMode,
    schemaHash: hash({ adapterVersion: 'referral/v1', storageMode, source: tableDefinitionHash(source['Create Table']),
      steps: plan.steps.map(({ id, checksum }) => ({ id, checksum })) }) }
}

export function referralSourceEvidence(stream, row) {
  check(stream === streamIdentity({ sourceTable: 'users', role: 'referral-account-v1' }), 'backfill_referral_evidence_stream')
  const { source, registeredAtUtc } = row.payload.provenance
  const converted = convertReferralAccounts([source], registeredAtUtc)
  check(row.pk.length === 1 && row.pk[0].type === 'integer' && row.pk[0].value === source.id
    && row.sourceHash === hash(source) && canonical(row.payload.target) === canonical(converted.entries[0].target), 'backfill_referral_evidence_mismatch')
  return { version: 1, sourceTable: 'users', projection: 'referral-source/v1', source, registeredAtUtc,
    historicalTimeConverted: false }
}

// Reuses the established transaction and commit-unknown implementation unchanged.
export class MysqlReferralBackfillRepository extends MysqlBackfillRepository {
  transaction(work) {
    return super.transaction(tx => {
      tx.targetIdentity = () => readReferralTargetIdentity(tx.connection)
      const insertReceipt = tx.insertReceipt.bind(tx)
      tx.insertReceipt = async (run, stream, batch, row) => {
        const payload = referralSourceEvidence(stream, row), pkHash = hash(row.pk)
        await insertReceipt(run, stream, batch, row)
        await tx.connection.execute('INSERT INTO data_migration_source_rows (run_id,stream_id,source_pk_sha256,source_bytes_sha256,source_payload_json,created_at_utc) VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))',
          [run, stream, pkHash, row.sourceHash, canonical(payload)])
        const [[saved]] = await tx.connection.execute('SELECT source_bytes_sha256,source_payload_json FROM data_migration_source_rows WHERE run_id=? AND stream_id=? AND source_pk_sha256=? FOR UPDATE', [run, stream, pkHash])
        const actual = typeof saved?.source_payload_json === 'string' ? JSON.parse(saved.source_payload_json) : saved?.source_payload_json
        check(saved?.source_bytes_sha256 === row.sourceHash && canonical(actual) === canonical(payload), 'backfill_referral_evidence_readback')
      }
      return work(tx)
    })
  }
}
