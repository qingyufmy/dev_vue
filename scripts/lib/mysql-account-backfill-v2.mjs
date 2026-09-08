import { MysqlInplaceAccountBackfillRepository } from './mysql-inplace-account-backfill.mjs'
import { hash, requireBackfill as check, inplaceAccountTargets } from './v4-backfill-contract.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { verifyInplaceJournal } from './mysql-inplace-column-store.mjs'
import { coordinateInplaceSchema } from './inplace-schema-coordinator.mjs'
import { loadSubscriptionForeignKeyCoordinator } from './inplace-subscription-foreign-key-schema.mjs'

const root = new URL('../../', import.meta.url)

// A new identity version, rather than changing frozen v1 waves. The caller
// owns the upgrade lock and freezes this identity before preparing a run.
export async function readAccountBackfillV2Identity(connection) {
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === 'dev_vue' || /^dev_vue_m1_source_\d{8}_\d{2}$/.test(identity.db), 'backfill_inplace_database_invalid')
  check(await verifyInplaceJournal(connection), 'backfill_inplace_journal_required')
  const plan = await loadSubscriptionForeignKeyCoordinator(root)
  check(plan.steps.length === 147, 'backfill_account_registry_version')
  const result = await coordinateInplaceSchema(plan.store(connection), plan)
  check(result.structureComplete && result.steps.length === 147 && result.steps.every(step => step.status === 'completed'),
    'backfill_inplace_schema_not_complete')
  const sources = []
  for (const name of ['users', 'trading_accounts', 'mt5_account_ownership_history']) {
    const [[row]] = await connection.query(`SHOW CREATE TABLE \`${name}\``)
    check(typeof row?.['Create Table'] === 'string', 'backfill_inplace_source_missing')
    sources.push({ name, hash: tableDefinitionHash(row['Create Table']) })
  }
  const mode = 'inplace-account-v2'
  return { serverUuid: identity.uuid, database: identity.db, storageMode: mode,
    schemaHash: hash({ adapterVersion: 'coordinated-account/v2', mode, sources, routes: inplaceAccountTargets,
      steps: plan.steps.map(({ id, checksum }) => ({ id, checksum })) }) }
}

export class MysqlAccountBackfillV2Repository extends MysqlInplaceAccountBackfillRepository {
  constructor(pool) { super(pool, { sourceEvidence: true }) }
  transaction(work) {
    return super.transaction(tx => {
      tx.targetIdentity = () => readAccountBackfillV2Identity(tx.connection)
      return work(tx)
    })
  }
}
