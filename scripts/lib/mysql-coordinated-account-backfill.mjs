import { MysqlInplaceAccountBackfillRepository } from './mysql-inplace-account-backfill.mjs'
import { hash, requireBackfill as check, inplaceAccountTargets } from './v4-backfill-contract.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { verifyInplaceJournal } from './mysql-inplace-column-store.mjs'
import { loadInplaceSchemaCoordinator, coordinateInplaceSchema } from './inplace-schema-coordinator.mjs'

const root = new URL('../../', import.meta.url)

// New adapter version: preserve old executors and their frozen rehearsal hashes.
// The schema identity includes the entire registry, so old run IDs cannot silently resume.
export async function readCoordinatedAccountTargetIdentity(connection) {
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === 'dev_vue' || /^dev_vue_m1_source_\d{8}_\d{2}$/.test(identity.db), 'backfill_inplace_database_invalid')
  check(await verifyInplaceJournal(connection), 'backfill_inplace_journal_required')
  const plan = await loadInplaceSchemaCoordinator(root)
  const result = await coordinateInplaceSchema(plan.store(connection), plan)
  check(result.steps.every(step => step.status === 'completed'), 'backfill_inplace_schema_not_complete')
  const sources = []
  for (const name of ['users', 'trading_accounts', 'mt5_account_ownership_history']) {
    const [[row]] = await connection.query(`SHOW CREATE TABLE \`${name}\``)
    check(typeof row?.['Create Table'] === 'string', 'backfill_inplace_source_missing')
    sources.push({ name, hash: tableDefinitionHash(row['Create Table']) })
  }
  const mode = 'inplace-account-v2'
  return { serverUuid: identity.uuid, database: identity.db, storageMode: mode,
    schemaHash: hash({ adapterVersion: 'coordinated-account/v1', mode, sources, routes: inplaceAccountTargets,
      steps: plan.steps.map(({ id, checksum }) => ({ id, checksum })) }) }
}

export class MysqlCoordinatedAccountBackfillRepository extends MysqlInplaceAccountBackfillRepository {
  constructor(pool) { super(pool, { sourceEvidence: true }) }
  transaction(work) {
    return super.transaction(tx => {
      tx.targetIdentity = () => readCoordinatedAccountTargetIdentity(tx.connection)
      return work(tx)
    })
  }
}
