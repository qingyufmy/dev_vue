import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'
import { independentTables, independentStructureSource } from './independent-structure-plan.mjs'
import { orderedSchemaStep } from './inplace-ordered-schema-upgrade.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { loadLearningCompletionCoordinator } from './inplace-learning-completion-schema.mjs'
import { recoveryLearningDefinitionHash } from './learning-completion-recovery-rendering.mjs'

export async function loadIndependentStructureCoordinator(root) {
  const bytes = await readFile(new URL('docs/migration/dev-vue-independent-structure-reference-20260908.json', root))
  if (sha256(bytes) !== 'bcd7ce8b89703cccf65281465fad1a9f40abb34a8e8595df2ff6f5080ecafdea') throw Error('independent_structure_reference_hash')
  const proof = JSON.parse(bytes)
  if (!proof.verified || !proof.referenceTablesRemoved || !proof.originalSchemaDataCountersUnchanged || !proof.grantsRestored
    || proof.currentDevVueWritten || proof.seedsApplied || proof.identity.db !== 'dev_vue_m1_source_20260907_02'
    || proof.identity.uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104' || proof.steps.length !== 11) throw Error('independent_structure_reference_invalid')
  const source = await independentStructureSource(root)
  const sql = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/025_independent_runtime_structures.sql', root), 'utf8'))
  if (JSON.stringify(sql) !== JSON.stringify(source.map(row => row.sql))) throw Error('independent_structure_sql_drift')
  const steps = proof.steps.map((row, index) => {
    if (JSON.stringify(source[index]) !== JSON.stringify({ table: row.table, sql: row.sql, source: row.source,
      sourceSha256: row.sourceSha256, statementSha256: row.statementSha256 })
      || row.afterHash !== tableDefinitionHash(row.definition)
      || row.beforeHash !== (row.beforeDefinition === null ? null : tableDefinitionHash(row.beforeDefinition))) throw Error('independent_structure_reference_drift')
    return orderedSchemaStep({ id: `inplace_021_${String(index + 1).padStart(2, '0')}_${row.table}`,
      table: row.table, sql: row.sql, beforeHash: row.beforeHash, afterHash: row.afterHash })
  })
  const prior = await loadLearningCompletionCoordinator(root)
  return { ...prior, steps: [...prior.steps, ...steps],
    transitions: [...prior.transitions, ...steps.map(step => ({ step, key: step.table, before: step.beforeHash, after: step.afterHash }))],
    store(connection) {
      const base = prior.store(connection)
      return { ...base, async tableHash(name) {
        if (!independentTables.includes(name)) {
          const hash = await base.tableHash(name)
          if (!['learning_courses', 'learning_lessons', 'learning_media_references', 'learning_progress'].includes(name)) return hash
          const [[identity]] = await connection.query('SELECT DATABASE() db')
          if (identity.db !== 'dev_vue_m1_source_20260907_02') return hash
          const [[row]] = await connection.query(`SHOW CREATE TABLE \`${name}\``)
          return recoveryLearningDefinitionHash(identity.db, name, row['Create Table'])
        }
        const [tables] = await connection.execute('SELECT TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [name])
        if (!tables.length) return null
        if (tables.length !== 1 || tables[0].type !== 'BASE TABLE') throw Error('independent_structure_table_conflict')
        const [triggers] = await connection.execute('SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', [name])
        if (triggers.length) throw Error('independent_structure_trigger_conflict')
        const [[row]] = await connection.query(`SHOW CREATE TABLE \`${name}\``)
        return tableDefinitionHash(row['Create Table'])
      } }
    } }
}
