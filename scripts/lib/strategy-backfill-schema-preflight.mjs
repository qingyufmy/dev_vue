import { readFile } from 'node:fs/promises'
import { hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { loadStrategyUpgrade } from './inplace-strategy-upgrade.mjs'
import { loadHistoryRuntimeUpgrade } from './history-runtime-upgrade.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { mysqlColumnStore, verifyInplaceJournal } from './mysql-inplace-column-store.mjs'

export async function loadStrategyBackfillSchema(root) {
  const strategy = await loadStrategyUpgrade(root)
  const reference = JSON.parse(await readFile(new URL('docs/architecture/history-runtime-reference-20260909.json', root), 'utf8'))
  const history = await loadHistoryRuntimeUpgrade(root, reference)
  const source = JSON.parse(await readFile(new URL('docs/architecture/strategy-receipt-inventory-v3-20260909.json', root), 'utf8'))
  check(source.inspected === true && source.identity.db === 'dev_vue'
    && source.identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'strategy_schema_source_reference')
  const tables = Object.fromEntries(strategy.foundation.filter(step => step.table.startsWith('data_migration_')).map(step => [step.table, step.expectedHash]))
  tables[strategy.evidence.table] = strategy.evidence.expectedHash
  for (const step of strategy.steps) tables[step.table] = step.afterHash
  for (const table of ['auto_prompt_types', 'users']) {
    check(typeof source.definitions[table] === 'string', 'strategy_schema_source_definition')
    tables[table] = tableDefinitionHash(source.definitions[table])
  }
  const steps = history.steps.map(({ id, checksum }) => ({ id, checksum }))
  return { tables, steps, hash: hash({ tables, steps }) }
}

// Read-only structural admission. Role conversion, source snapshot and restored
// data reconciliation are separate requirements; this result never authorizes apply.
export async function inspectStrategyBackfillSchema(connection, plan, expectedDatabase) {
  plan = structuredClone(plan)
  check(expectedDatabase === 'dev_vue' || /^dev_vue_strategy_restore_[a-f0-9]{32}$/.test(expectedDatabase)
    || /^dev_vue_m1_source_\d{8}_\d{2}$/.test(expectedDatabase), 'strategy_schema_database_scope')
  check(plan.hash === hash({ tables: plan.tables, steps: plan.steps }), 'strategy_schema_plan_changed')
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === expectedDatabase && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'strategy_schema_database_identity')
  check(await verifyInplaceJournal(connection), 'strategy_schema_journal_missing')
  const history = await mysqlColumnStore(connection, true).history(), actual = new Map(history.map(row => [row.id, row]))
  const mismatched = plan.steps.filter(step => actual.get(step.id)?.checksum !== step.checksum || actual.get(step.id)?.status !== 'completed').map(step => step.id)
  const journalMatches = history.length === plan.steps.length && mismatched.length === 0
  const tables = []
  for (const [name, expectedHash] of Object.entries(plan.tables)) {
    check(/^[a-z][a-z0-9_]*$/.test(name), 'strategy_schema_table_name')
    const [objects] = await connection.execute('SELECT TABLE_TYPE kind,ENGINE engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [name])
    let actualHash = null
    const [triggers] = await connection.execute('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', [name])
    if (objects.length === 1 && objects[0].kind === 'BASE TABLE' && objects[0].engine === 'InnoDB') {
      const [[definition]] = await connection.query(`SHOW CREATE TABLE \`${name}\``)
      actualHash = tableDefinitionHash(definition['Create Table'])
    }
    tables.push({ name, expectedHash, actualHash, triggers: triggers.length, matches: actualHash === expectedHash && triggers.length === 0 })
  }
  return { schemaReady: journalMatches && tables.every(table => table.matches), identity, planHash: plan.hash,
    journal: { actualCount: history.length, expectedCount: plan.steps.length, matches: journalMatches, mismatched }, tables,
    applyReady: false, remainingChecks: ['role_conversion', 'source_snapshot_binding', 'restored_data_reconciliation', 'subscription_promotion'] }
}
