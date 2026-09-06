import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadMigrationPlan, splitSqlStatements } from './v4-migration-plan.mjs'
import { inplaceColumnSteps } from './dev-vue-column-upgrade.mjs'
import { loadFoundationSteps, tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { loadAccountBuildSteps } from './inplace-account-build.mjs'
import { loadSourceEvidenceStep, inspectSourceEvidence, executeSourceEvidence } from './inplace-source-evidence-upgrade.mjs'
import { orderedSchemaStep, executeOrderedSchema } from './inplace-ordered-schema-upgrade.mjs'

export const strategyTableNames = Object.freeze(['strategies', 'strategy_versions'])
export async function loadStrategyUpgrade(root) {
  const reference = JSON.parse(await readFile(new URL('docs/migration/dev-vue-strategy-reference-20260906.json', root), 'utf8'))
  if (reference.identity.server_uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104'
    || reference.identity.database_name !== 'dev_vue_m1_a'
    || JSON.stringify(reference.tables.map(table => table.name)) !== JSON.stringify(strategyTableNames)) throw new Error('inplace_strategy_reference_invalid')
  const [strategy, version] = reference.tables.map(table => table.ddl)
  const foreignKey = strategy.split('\n').filter(line => line.startsWith('  CONSTRAINT `fk_strategies_active_version`'))
  if (foreignKey.length !== 1) throw new Error('inplace_strategy_cycle_invalid')
  const initialStrategy = strategy.replace(foreignKey[0] + '\n', '')
  const sql = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/006_strategy_tables.sql', root), 'utf8'))
  const expected = [initialStrategy, version, 'ALTER TABLE `strategies` ADD ' + foreignKey[0].trim().replace(/,$/, '')]
  if (JSON.stringify(sql) !== JSON.stringify(expected)) throw new Error('inplace_strategy_sql_reference_mismatch')
  const rootPlan = await loadMigrationPlan({ rootDirectory: fileURLToPath(root) })
  const originals = rootPlan.flatMap(migration => migration.statements.filter(statement => /^(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE)\s+`?(strategies|strategy_versions)`?\s/i.test(statement)).map(statement => ({ migration: migration.id, checksum: migration.checksum, sql: statement })))
  if (originals.length !== 3 || originals.some(row => row.migration !== '20260903_004_ai_strategy_and_inference_core')) throw new Error('inplace_strategy_unreviewed_root_change')
  const foundation = await loadFoundationSteps(root), build = await loadAccountBuildSteps(root), evidence = await loadSourceEvidenceStep(root)
  const steps = [
    orderedSchemaStep({ id: 'inplace_005_01_strategies', table: 'strategies', sql: sql[0], beforeHash: null, afterHash: tableDefinitionHash(initialStrategy) }),
    orderedSchemaStep({ id: 'inplace_005_02_strategy_versions', table: 'strategy_versions', sql: sql[1], beforeHash: null, afterHash: tableDefinitionHash(version) }),
    orderedSchemaStep({ id: 'inplace_005_03_strategy_active_version_fk', table: 'strategies', sql: sql[2], beforeHash: tableDefinitionHash(initialStrategy), afterHash: tableDefinitionHash(strategy) }),
  ]
  return { foundation, build, evidence, originals, priorSteps: [...inplaceColumnSteps, ...foundation, ...build, evidence], initialTables: { strategies: null, strategy_versions: null }, steps }
}

export function strategyStore(connection, store, plan) {
  const base = inspectSourceEvidence(connection, store)
  return { ...base,
    async assertPrerequisites() {
      await executeSourceEvidence({ ...base, history: async () => (await base.history()).filter(row => plan.priorSteps.some(step => step.id === row.id)) }, plan.foundation, plan.build, plan.evidence)
    },
    async tableHash(name) {
      if (!strategyTableNames.includes(name)) return base.tableHash(name)
      const [tables] = await connection.execute('SELECT TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [name])
      if (!tables.length) return null
      if (tables[0].type !== 'BASE TABLE') throw new Error('inplace_strategy_table_conflict')
      const [triggers] = await connection.execute('SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', [name])
      if (triggers.length) throw new Error('inplace_strategy_trigger_conflict')
      const [[row]] = await connection.query(`SHOW CREATE TABLE \`${name}\``)
      return tableDefinitionHash(row['Create Table'])
    },
  }
}
export const executeStrategyUpgrade = (store, plan, options) => executeOrderedSchema(store, plan, options)
