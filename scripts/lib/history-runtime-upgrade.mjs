import { readFile } from 'node:fs/promises'
import { loadHistoryProvenanceMigration } from './history-provenance-upgrade.mjs'
import { splitSqlStatements, sha256 } from './v4-migration-plan.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { hash } from './v4-backfill-contract.mjs'

const scope = [
  ['CREATE', 'trade_history_sync_states_v4'], ['CREATE', 'terminal_history_orders_v4'], ['CREATE', 'terminal_history_deals_v4'],
  ['CREATE', 'account_trade_records_v4'], ['CREATE', 'account_trade_record_deals_v4'], ['CREATE', 'account_trade_attributions_v4'],
  ['CREATE', 'account_trade_daily_summaries_v4'], ['ALTER', 'account_trade_records_v4'], ['ALTER', 'account_trade_records_v4'],
  ['ALTER', 'terminal_history_deals_v4'], ['ALTER', 'account_trade_records_v4'],
]
export async function loadHistoryRuntimeUpgrade(root, reference) {
  const legacy = await loadHistoryProvenanceMigration(root)
  const prior = legacy.prior
  const source = 'server/db/migrations/inplace/047_trade_history_runtime_tables.sql'
  const bytes = await readFile(new URL(source, root)), sourceSha256 = sha256(bytes)
  if (sourceSha256 !== 'e5e4ea08b58742030ee8e490860440a12d3e425ea596a1c1d484fbc6a560ba74') throw Error('history_runtime_source_changed')
  const statements = splitSqlStatements(bytes.toString('utf8'))
  const checks = ['eleven_history_prerequisite_statements_in_dependency_order', 'real_writer_insert_replay_and_conflict',
    'three_real_foreign_keys', 'revision_and_hash_check_constraints', 'transaction_rollback_preserves_prior_receipt']
  if (reference?.kind !== 'history-runtime-schema-reference/v1' || reference.passed !== true || reference.referenceDatabaseRemoved !== true
    || reference.existingDatabaseWrites !== 0 || reference.serverUuid !== 'ac423207-6ef3-11f1-b302-000c29fda104'
    || reference.prerequisitesSha256 !== sourceSha256 || reference.migrationSha256 !== legacy.step.sourceSha256
    || hash(reference.checks) !== hash(checks) || reference.steps?.length !== 11 || statements.length !== 11) throw Error('history_runtime_reference_invalid')
  const steps = [...prior.steps], added = [], latest = new Map()
  for (const [index, sql] of statements.entries()) {
    const [operation, table] = scope[index], evidence = reference.steps[index]
    if (!new RegExp(`^${operation} TABLE ${table}\\s`).test(sql) || evidence.index !== index + 1 || evidence.operation !== operation
      || evidence.table !== table || evidence.sqlSha256 !== sha256(sql)
      || !evidence.canonicalDdl?.startsWith(`CREATE TABLE \`${table}\` (`)) throw Error('history_runtime_step_reference_invalid')
    const body = { id: `inplace_047_${String(index + 1).padStart(2, '0')}_${table}`, table, operation,
      protocol: 'history-runtime-structure/v1', source, sourceSha256, sql,
      priorRegistryHash: hash(steps.map(({ id, checksum }) => ({ id, checksum }))),
      beforeHash: latest.get(table) ?? null, afterHash: tableDefinitionHash(evidence.canonicalDdl) }
    if ((operation === 'ALTER') !== latest.has(table)) throw Error('history_runtime_dependency_invalid')
    const step = { ...body, checksum: hash(body) }
    steps.push(step); added.push(step); latest.set(table, step.afterHash)
  }
  if (!reference.canonicalDdl?.startsWith('CREATE TABLE `terminal_history_order_provenance_v4` (')) throw Error('history_runtime_provenance_reference_invalid')
  for (const [table, value] of latest) {
    if (!reference.tables?.[table] || tableDefinitionHash(reference.tables[table]) !== value) throw Error('history_runtime_final_reference_invalid')
  }
  const { checksum: unused, ...original } = legacy.step
  const body = { ...original, operation: 'CREATE', protocol: 'history-runtime-structure/v1',
    priorRegistryHash: hash(steps.map(({ id, checksum }) => ({ id, checksum }))), beforeHash: null,
    afterHash: tableDefinitionHash(reference.canonicalDdl) }
  const last = { ...body, checksum: hash(body) }
  steps.push(last); added.push(last); latest.set(last.table, last.afterHash)
  if (steps.length !== 188 || added.length !== 12) throw Error('history_runtime_plan_size')
  return { prior, steps, added, finalTableHashes: Object.fromEntries(latest), referenceHash: hash(reference) }
}
export const historyRuntimePlanHash = plan => hash({ steps: plan.steps, priorSteps: plan.prior.steps, added: plan.added,
  finalTableHashes: plan.finalTableHashes, referenceHash: plan.referenceHash })
