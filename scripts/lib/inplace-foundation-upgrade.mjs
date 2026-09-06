import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements, loadMigrationPlan } from './v4-migration-plan.mjs'
import { fileURLToPath } from 'node:url'
import { executeColumnSteps, inplaceColumnSteps, validateColumnHistory } from './dev-vue-column-upgrade.mjs'

export const foundationNames = Object.freeze(['auth_sessions', 'auth_authorization_codes', 'terminal_profiles',
  'bridge_connection_capacity_grants', 'data_migration_runs', 'data_migration_checkpoints', 'data_migration_batches',
  'data_migration_id_maps', 'data_migration_row_receipts'])

export function tableDefinitionHash(ddl) {
  // AUTO_INCREMENT's current counter is data state; retain column AUTO_INCREMENT and every constraint.
  return sha256(ddl.replace(/\r\n/g, '\n')
    .replace(/CHARACTER SET utf8mb4 COLLATE (utf8mb4_[a-z0-9_]+)/g, 'COLLATE $1')
    .replace(/(\) ENGINE=[^\n]*?) AUTO_INCREMENT=\d+(?= |$)/, '$1'))
}

export async function loadFoundationSteps(root) {
  const sql = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/003_identity_migration_tables.sql', root), 'utf8'))
  if (sql.length !== foundationNames.length) throw new Error('inplace_foundation_plan_size')
  const plan = await loadMigrationPlan({ rootDirectory: fileURLToPath(root) })
  return sql.map((statement, index) => {
    const table = /^CREATE TABLE `([a-z][a-z0-9_]*)` \(/.exec(statement)?.[1]
    if (table !== foundationNames[index]) throw new Error('inplace_foundation_plan_table')
    const originals = plan.flatMap(migration => migration.statements.filter(item =>
      new RegExp('^(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE)\\s+`?' + table + '`?\\s', 'i').test(item)).map(item => ({ migration: migration.id, checksum: migration.checksum, sql: item })))
    if (originals.length !== 1 || !/^CREATE TABLE/i.test(originals[0].sql)) throw new Error('inplace_foundation_unreviewed_alter')
    const expectedHash = tableDefinitionHash(statement)
    return { id: `inplace_002_${String(index + 1).padStart(2, '0')}_${table}`, table, sql: statement, expectedHash,
      checksum: sha256(JSON.stringify({ sql: statement, expectedHash, original: originals[0] })) }
  })
}

export async function executeFoundationSteps(store, steps, { apply = false } = {}) {
  const rows = await store.history()
  const history = validateColumnHistory(rows, [...inplaceColumnSteps, ...steps])
  if (!inplaceColumnSteps.every(step => history.get(step.id)?.status === 'completed')) throw new Error('inplace_columns_required')
  // Validate the original phase with its frozen executor after validating the entire registry.
  await executeColumnSteps({ ...store, history: async () => rows.filter(row => inplaceColumnSteps.some(step => step.id === row.id)) })
  const states = []
  for (const step of steps) {
    const journal = history.get(step.id)
    const actual = await store.tableHash(step.table)
    if (actual !== null && actual !== step.expectedHash) throw new Error('inplace_table_definition_conflict')
    if (actual !== null && !journal) throw new Error('inplace_unrecorded_table')
    if (actual === null && journal?.status === 'completed') throw new Error('inplace_completed_table_missing')
    states.push({ step, journal, actual })
  }
  const report = []
  for (const { step, journal, actual } of states) {
    if (journal?.status === 'completed') { report.push({ id: step.id, status: 'completed' }); continue }
    if (!apply) { report.push({ id: step.id, status: actual ? 'reconcile' : 'pending' }); continue }
    if (!journal) await store.begin(step)
    if (!actual) await store.execute(step.sql)
    if (await store.tableHash(step.table) !== step.expectedHash) throw new Error('inplace_table_postcondition_failed')
    await store.complete(step)
    report.push({ id: step.id, status: actual ? 'reconciled' : 'applied' })
  }
  return { apply, steps: report }
}

export function withTableInspection(connection, store) {
  return { ...store, async tableHash(name) {
    if (!foundationNames.includes(name)) throw new Error('inplace_table_not_registered')
    const [tables] = await connection.execute('SELECT TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [name])
    if (!tables.length) return null
    if (tables[0].type !== 'BASE TABLE') throw new Error('inplace_table_kind_conflict')
    const [triggers] = await connection.execute('SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', [name])
    if (triggers.length) throw new Error('inplace_table_trigger_conflict')
    const [[row]] = await connection.query(`SHOW CREATE TABLE \`${name}\``)
    return tableDefinitionHash(row['Create Table'])
  } }
}
