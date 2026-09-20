import { coordinateSingleTableUpgrade } from './single-table-upgrade-coordinator.mjs'
import { loadInstrumentCollectionMigration } from './inplace-instrument-collection-schema.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { hash } from './v4-backfill-contract.mjs'

export const instrumentCollectionPlanHash = plan => hash({ steps: plan.steps, step: plan.step, referenceHash: plan.referenceHash })

export async function loadInstrumentCollectionUpgrade(root, reference) {
  const plan = await loadInstrumentCollectionMigration(root)
  const checks = ['real_user_and_account_foreign_keys', 'scope_uniqueness_and_case_sensitive_symbol',
    'lease_and_success_constraints', 'concurrent_claim_and_stale_completion_fencing']
  if (reference?.kind !== 'instrument-schema-reference/v1' || reference.passed !== true
    || reference.referenceDatabaseRemoved !== true || reference.existingDatabaseWrites !== 0
    || reference.serverUuid !== 'ac423207-6ef3-11f1-b302-000c29fda104'
    || reference.migrationSha256 !== plan.step.sourceSha256 || hash(reference.checks) !== hash(checks)
    || !reference.canonicalDdl?.startsWith('CREATE TABLE `instrument_collection_requests_v4` (')) throw Error('instrument_upgrade_reference_invalid')
  return { ...plan, step: { ...plan.step, afterHash: tableDefinitionHash(reference.canonicalDdl) }, referenceHash: hash(reference) }
}

/** plan.step.afterHash must come from separately verified real-MySQL canonical DDL, not source SQL. */
export async function coordinateInstrumentCollectionUpgrade(store, plan, options) {
  if (plan.steps.length !== 176 || plan.prior.steps.length !== 175
    || plan.step.id !== 'inplace_045_01_instrument_collection_requests_v4'
    || plan.step.table !== 'instrument_collection_requests_v4') throw Error('instrument_upgrade_scope')
  return coordinateSingleTableUpgrade(store, plan, 'instrument_upgrade', options)
}
