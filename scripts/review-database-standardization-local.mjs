import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import { loadSettingsMigrationEnvironment, settingsMigrationConnectionOptions } from './lib/settings-migration-environment.mjs'
import { loadMigrationPlan, sha256 } from './lib/v4-migration-plan.mjs'
import { plannedColumns, matrixRows } from './lib/v4-upgrade-review.mjs'
import { reviewTableDependencies } from './lib/inplace-table-dependencies.mjs'
import { loadModelCapacityCoordinator } from './lib/inplace-model-capacity-schema.mjs'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { withInplaceUpgradeLock, verifyInplaceJournal } from './lib/mysql-inplace-column-store.mjs'
import { databaseTypeToken } from './lib/database-structure-comparison.mjs'

const root = new URL('../', import.meta.url)
const check = (condition, code) => { if (!condition) throw Error(`standardization_review_${code}`) }
let connection, output
try {
  const [mode, destination] = process.argv.slice(2)
  check(mode === '--read-only' && process.argv.length === 4 && isAbsolute(destination), 'arguments')
  output = await open(destination, 'wx', 0o600)
  const env = await loadSettingsMigrationEnvironment(root)
  check(env.MYSQL_DATABASE === 'dev_vue' && env.MYSQL_USER === 'dev_vue', 'environment')
  connection = await mysql.createConnection({ ...settingsMigrationConnectionOptions(env), connectTimeout: 5000 })
  await connection.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await connection.query('SELECT DATABASE() database_name,@@server_uuid server_uuid,VERSION() mysql_version,@@session.time_zone session_timezone,@@session.sql_mode sql_mode')
  check(identity.database_name === 'dev_vue' && identity.server_uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'identity')
  const plan = await loadMigrationPlan({ rootDirectory: fileURLToPath(root) })
  const matrix = matrixRows(await readFile(new URL('docs/database-table-migration-matrix.md', root), 'utf8'))
  const baseline = JSON.parse(await readFile(new URL('docs/migration/dev-vue-inplace-source-20260906.json', root), 'utf8'))
  const result = await withInplaceUpgradeLock(connection, 'dev_vue', async () => {
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    try {
      check(await verifyInplaceJournal(connection), 'journal')
      const coordinator = await loadModelCapacityCoordinator(root)
      const schema = await coordinateInplaceSchema(coordinator.store(connection), coordinator)
      check(schema.structureComplete && schema.steps.length === 105, 'schema_steps')
      const collect = async () => {
        const query = async sql => (await connection.query(sql))[0]
        const tables = await query('SELECT TABLE_NAME table_name,TABLE_TYPE table_type,ENGINE engine,TABLE_COLLATION collation FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME')
        const columns = await query('SELECT TABLE_NAME table_name,COLUMN_NAME column_name,ORDINAL_POSITION ordinal_position,COLUMN_TYPE column_type,IS_NULLABLE is_nullable,COLUMN_DEFAULT column_default,CHARACTER_SET_NAME charset,COLLATION_NAME collation,EXTRA extra,GENERATION_EXPRESSION generation_expression,DATETIME_PRECISION datetime_precision FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION')
        const indexes = await query('SELECT TABLE_NAME table_name,INDEX_NAME index_name,NON_UNIQUE non_unique,SEQ_IN_INDEX seq_in_index,COLUMN_NAME column_name,SUB_PART sub_part,INDEX_TYPE index_type,IS_VISIBLE is_visible,EXPRESSION expression FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX')
        const relations = await query('SELECT TABLE_NAME table_name,CONSTRAINT_NAME constraint_name,COLUMN_NAME column_name,ORDINAL_POSITION ordinal_position,REFERENCED_TABLE_NAME referenced_table_name,REFERENCED_COLUMN_NAME referenced_column_name FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION')
        const checks = await query('SELECT t.TABLE_NAME table_name,c.CONSTRAINT_NAME constraint_name,c.CHECK_CLAUSE check_clause,t.ENFORCED enforced FROM information_schema.CHECK_CONSTRAINTS c JOIN information_schema.TABLE_CONSTRAINTS t ON t.CONSTRAINT_SCHEMA=c.CONSTRAINT_SCHEMA AND t.CONSTRAINT_NAME=c.CONSTRAINT_NAME WHERE c.CONSTRAINT_SCHEMA=DATABASE() ORDER BY t.TABLE_NAME,c.CONSTRAINT_NAME')
        const foreignKeys = await query('SELECT TABLE_NAME table_name,CONSTRAINT_NAME constraint_name,REFERENCED_TABLE_NAME referenced_table_name,UPDATE_RULE update_rule,DELETE_RULE delete_rule FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() ORDER BY TABLE_NAME,CONSTRAINT_NAME')
        const triggers = await query('SELECT TRIGGER_NAME name,EVENT_OBJECT_TABLE table_name,ACTION_TIMING timing,EVENT_MANIPULATION event FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME')
        const routines = await query('SELECT ROUTINE_NAME name,ROUTINE_TYPE type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE() ORDER BY ROUTINE_NAME')
        const events = await query('SELECT EVENT_NAME name,STATUS status FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE() ORDER BY EVENT_NAME')
        const definitions = []
        for (const table of tables) {
          check(/^[a-z][a-z0-9_]*$/.test(table.table_name) && table.table_type === 'BASE TABLE', 'table_kind')
          const [[row]] = await connection.query(`SHOW CREATE TABLE \`${table.table_name}\``)
          const [[count]] = await connection.query(`SELECT COUNT(*) row_count FROM \`${table.table_name}\``)
          definitions.push({ name: table.table_name, rowCount: String(count.row_count), sql: row['Create Table'], sha256: sha256(row['Create Table']) })
        }
        return { tables, columns, indexes, relations, checks, foreignKeys, triggers, routines, events, definitions }
      }
      const first = await collect(), second = await collect()
      check(JSON.stringify(first) === JSON.stringify(second), 'metadata_changed')
      const target = plannedColumns(plan)
      const dependencies = reviewTableDependencies(plan, first)
      const original = new Set(baseline.tables.map(table => table.table_name))
      const observed = new Set(first.tables.map(table => table.table_name))
      const sourceCoverage = baseline.tables.map(table => ({ name: table.table_name,
        present: observed.has(table.table_name), domain: matrix.get(table.table_name)?.domain ?? null,
        action: matrix.get(table.table_name)?.action ?? null,
        missingColumns: baseline.columns.filter(column => column.table_name === table.table_name)
          .filter(column => !first.columns.some(actual => actual.table_name === column.table_name && actual.column_name === column.column_name)).map(column => column.column_name),
      }))
      const existingTargetGaps = Object.entries(target).filter(([name]) => observed.has(name)).map(([name, columns]) => ({ name,
        missingColumns: Object.keys(columns).filter(column => !first.columns.some(actual => actual.table_name === name && actual.column_name === column)),
      })).filter(row => row.missingColumns.length)
      // Type tokens are an inventory finding, not a semantic conversion or constraint proof.
      const targetFields = Object.entries(target).flatMap(([table, fields]) => Object.entries(fields).map(([column, planned]) => {
        const actual = first.columns.find(row => row.table_name === table && row.column_name === column)
        return { table, column, planned, actual: actual ?? null,
          nullabilityDifference: actual ? actual.is_nullable !== (/\bNOT NULL\b/i.test(planned.declaration) ? 'NO' : 'YES') : null,
          status: !observed.has(table) ? 'table_missing' : !actual ? 'column_missing'
            : databaseTypeToken(planned.declaration) !== databaseTypeToken(actual.column_type) ? 'type_difference' : 'type_token_matches_review_semantics' }
      }))
      return { kind: 'database-standardization-current-inventory/v1', observedAt: new Date().toISOString(), identity,
        databaseWrites: 0, schemaSteps: schema.steps, catalogSha256: sha256(JSON.stringify(first)),
        visibility: 'Application-account metadata only; empty routines/events/triggers do not prove privileged object absence.',
        summary: { tables: first.tables.length, columns: first.columns.length,
          indexes: new Set(first.indexes.map(row => `${row.table_name}/${row.index_name}`)).size,
          checks: first.checks.length, foreignKeys: first.foreignKeys.length,
          rows: first.definitions.reduce((sum, row) => sum + BigInt(row.rowCount), 0n).toString(),
          originalTables: original.size, addedTables: first.tables.filter(row => !original.has(row.table_name)).length,
          missingOriginalTables: sourceCoverage.filter(row => !row.present).length,
          missingOriginalColumns: sourceCoverage.reduce((sum, row) => sum + row.missingColumns.length, 0),
          missingPlannedTables: dependencies.summary.newTables, dependencyCandidates: dependencies.summary.candidates,
          dependencyBlocked: dependencies.summary.blocked, existingTargetColumnGaps: existingTargetGaps.length,
          targetTypeDifferences: targetFields.filter(row => row.status === 'type_difference').length,
          targetNullabilityDifferences: targetFields.filter(row => row.nullabilityDifference === true).length },
        sourceCoverage, existingTargetGaps, targetFields, dependencies, ...first }
    } finally { await connection.rollback() }
  })
  await output.writeFile(JSON.stringify(result, null, 2) + '\n'); await output.sync()
  console.log(JSON.stringify(result.summary))
} catch (error) {
  console.error(JSON.stringify({ code: /^standardization_review_[a-z_]+$/.test(error.message) ? error.message : 'standardization_review_failed' }))
  process.exitCode = 1
} finally { await connection?.end(); await output?.close() }
