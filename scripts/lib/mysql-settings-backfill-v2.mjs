import { MysqlSettingsBackfillRepository } from './mysql-settings-backfill.mjs'
import { hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { verifyInplaceJournal } from './mysql-inplace-column-store.mjs'
import { coordinateInplaceSchema } from './inplace-schema-coordinator.mjs'
import { loadSettingRequestCoordinator } from './inplace-setting-request-schema.mjs'

const root = new URL('../../', import.meta.url)
// Retain the historical 57-step adapter and its evidence. New batches bind all
// 58 steps, including the settings request receipt schema, in their schema hash.
export async function readSettingsTargetIdentityV2(connection) {
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === 'dev_vue' || /^dev_vue_m1_source_\d{8}_\d{2}$/.test(identity.db), 'backfill_settings_database_invalid')
  check(await verifyInplaceJournal(connection), 'backfill_settings_journal_required')
  const plan = await loadSettingRequestCoordinator(root)
  const result = await coordinateInplaceSchema(plan.store(connection), plan)
  check(result.structureComplete && result.steps.every(step => step.status === 'completed'), 'backfill_settings_schema_incomplete')
  const [[source]] = await connection.query('SHOW CREATE TABLE `system_config`')
  const storageMode = 'inplace-settings-v1'
  return { serverUuid: identity.uuid, database: identity.db, storageMode,
    schemaHash: hash({ adapterVersion: 'settings/v2', storageMode, source: tableDefinitionHash(source['Create Table']),
      steps: plan.steps.map(({ id, checksum }) => ({ id, checksum })) }) }
}

export class MysqlSettingsBackfillRepositoryV2 extends MysqlSettingsBackfillRepository {
  transaction(work) {
    return super.transaction(tx => {
      tx.targetIdentity = () => readSettingsTargetIdentityV2(tx.connection)
      return work(tx)
    })
  }
}
