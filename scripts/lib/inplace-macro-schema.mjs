import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadMigrationPlan, splitSqlStatements } from './v4-migration-plan.mjs'
import { loadInplaceSchemaCoordinator } from './inplace-schema-coordinator.mjs'
import { orderedSchemaStep } from './inplace-ordered-schema-upgrade.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'

export const macroTableNames = Object.freeze(['macro_data_sources', 'macro_feature_sets', 'economic_calendar_events',
  'macro_model_versions', 'macro_series', 'macro_ingestion_runs', 'macro_pipeline_jobs', 'macro_research_snapshots',
  'economic_calendar_event_revisions', 'macro_observations', 'macro_snapshot_observations'])

export async function loadMacroSchemaCoordinator(root) {
  const reference = JSON.parse(await readFile(new URL('docs/migration/dev-vue-macro-schema-reference-20260907.json', root), 'utf8'))
  if (reference.kind !== 'macro-schema-reference/v1' || reference.identity.db !== 'dev_vue_m1_a'
    || reference.identity.uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104'
    || reference.tables.length !== macroTableNames.length || new Set(reference.tables.map(t => t.name)).size !== macroTableNames.length
    || reference.tables.some(t => !macroTableNames.includes(t.name) || t.rows !== '0')) throw new Error('inplace_macro_reference_invalid')
  const migrations = await loadMigrationPlan({ rootDirectory: fileURLToPath(root) })
  if (reference.migrations.length !== migrations.length || migrations.some(m => !reference.migrations.some(r => r.id === m.id
    && r.status === 'completed' && r.checksum_sha256 === m.checksum))) throw new Error('inplace_macro_reference_history_changed')
  const sql = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/008_macro_tables.sql', root), 'utf8'))
  if (sql.length !== macroTableNames.length || sql.some((statement, i) => statement !== reference.tables.find(t => t.name === macroTableNames[i]).ddl)) throw new Error('inplace_macro_sql_reference_mismatch')
  const available = new Set(['users'])
  const added = sql.map((statement, index) => {
    const table = macroTableNames[index]
    for (const match of statement.matchAll(/REFERENCES `([^`]+)`/g)) {
      if (match[1] !== table && !available.has(match[1])) throw new Error('inplace_macro_dependency_order')
    }
    available.add(table)
    return orderedSchemaStep({ id: `inplace_007_${String(index + 1).padStart(2, '0')}_${table}`, table,
      sql: statement, beforeHash: null, afterHash: tableDefinitionHash(statement) })
  })
  const prior = await loadInplaceSchemaCoordinator(root)
  return { steps: [...prior.steps, ...added], transitions: [...prior.transitions,
    ...added.map(step => ({ step, key: step.table, before: null, after: step.afterHash }))],
    store(connection) {
      const base = prior.store(connection)
      return { ...base, async tableHash(name) {
        if (!macroTableNames.includes(name)) return base.tableHash(name)
        const [tables] = await connection.execute('SELECT TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [name])
        if (!tables.length) return null
        if (tables.length !== 1 || tables[0].type !== 'BASE TABLE') throw new Error('inplace_macro_table_conflict')
        const [triggers] = await connection.execute('SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', [name])
        if (triggers.length) throw new Error('inplace_macro_trigger_conflict')
        const [[row]] = await connection.query(`SHOW CREATE TABLE \`${name}\``)
        return tableDefinitionHash(row['Create Table'])
      } }
    } }
}
