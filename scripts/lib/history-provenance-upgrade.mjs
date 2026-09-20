import { readFile } from 'node:fs/promises'
import { loadInstrumentCollectionUpgrade } from './instrument-collection-upgrade.mjs'
import { splitSqlStatements, sha256 } from './v4-migration-plan.mjs'
import { hash } from './v4-backfill-contract.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'

export async function loadHistoryProvenanceMigration(root) {
  const reference = JSON.parse(await readFile(new URL('docs/architecture/instrument-schema-reference-20260909.json', root), 'utf8'))
  const prior = await loadInstrumentCollectionUpgrade(root, reference)
  if (prior.steps.length !== 176) throw Error('history_provenance_prior_version')
  const source = 'server/db/migrations/inplace/046_terminal_history_order_provenance.sql'
  const bytes = await readFile(new URL(source, root))
  if (sha256(bytes) !== 'd794d24368c2904bcaeabcea8d88263363548042320a3e8536f8479157558113') throw Error('history_provenance_source_changed')
  const statements = splitSqlStatements(bytes.toString('utf8'))
  if (statements.length !== 1 || !/^CREATE TABLE terminal_history_order_provenance_v4\s*\(/.test(statements[0])) throw Error('history_provenance_scope')
  const body = { id: 'inplace_046_01_terminal_history_order_provenance_v4', table: 'terminal_history_order_provenance_v4',
    protocol: 'history-order-provenance-structure/v1', source, sourceSha256: sha256(bytes), sql: statements[0],
    priorRegistryHash: hash(prior.steps.map(({ id, checksum }) => ({ id, checksum }))) }
  const step = { ...body, checksum: hash(body) }
  return { prior, step, steps: [...prior.steps, step] }
}

export async function loadHistoryProvenanceUpgrade(root, reference) {
  const plan = await loadHistoryProvenanceMigration(root)
  const checks = ['real_writer_insert_replay_and_conflict', 'three_real_foreign_keys',
    'revision_and_hash_check_constraints', 'transaction_rollback_preserves_prior_receipt']
  if (reference?.kind !== 'history-order-provenance-reference/v1' || reference.passed !== true
    || reference.referenceDatabaseRemoved !== true || reference.existingDatabaseWrites !== 0
    || reference.serverUuid !== 'ac423207-6ef3-11f1-b302-000c29fda104'
    || reference.migrationSha256 !== plan.step.sourceSha256 || hash(reference.checks) !== hash(checks)
    || !reference.canonicalDdl?.startsWith('CREATE TABLE `terminal_history_order_provenance_v4` (')) throw Error('history_provenance_reference_invalid')
  return { ...plan, step: { ...plan.step, afterHash: tableDefinitionHash(reference.canonicalDdl) }, referenceHash: hash(reference) }
}

export const historyProvenancePlanHash = plan => hash({ steps: plan.steps, step: plan.step, referenceHash: plan.referenceHash })

export async function coordinateHistoryProvenanceUpgrade(store, plan, options) {
  if (plan.steps.length !== 177 || plan.prior.steps.length !== 176
    || plan.step.id !== 'inplace_046_01_terminal_history_order_provenance_v4'
    || plan.step.table !== 'terminal_history_order_provenance_v4') throw Error('history_provenance_upgrade_scope')
  throw Error('history_provenance_upgrade_superseded_by_history_runtime')
}
