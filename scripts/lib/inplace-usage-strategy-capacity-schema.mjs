import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'
import { runtimeIndexTransitions, runtimeIndexObservedHash } from './inplace-runtime-index-schema.mjs'
import { loadFoundationForeignKeyCoordinator } from './inplace-foundation-foreign-key-schema.mjs'

export async function usageStrategyCapacityTransitions(root) {
  const bytes = await readFile(new URL('docs/migration/dev-vue-usage-strategy-capacity-source-20260908.json', root))
  if (sha256(bytes) !== 'ea9b97b786d6bbc46f4fdc318b028a29cd923d518082b78bfadbe068b55a0b25') throw Error('usage_strategy_source_hash')
  const source = JSON.parse(bytes), table = 'ai_model_usage_logs'
  if (source.schemaSteps !== 144 || source.databaseWrites !== 0 || source.data.negative_count !== '0'
    || source.relations.length || source.metadata.column_type !== 'int' || source.metadata.is_nullable !== 'YES'
    || source.metadata.column_default !== null || source.metadata.extra !== '') throw Error('usage_strategy_source_invalid')
  const beforeLine = '  `strategy_id` int DEFAULT NULL,', afterLine = '  `strategy_id` bigint unsigned DEFAULT NULL,'
  if (source.definition.split('\n').filter(line => line === beforeLine).length !== 1) throw Error('usage_strategy_definition')
  const beforeDefinition = source.definition, afterDefinition = beforeDefinition.replace(beforeLine, afterLine)
  const indexes = await runtimeIndexTransitions(root)
  const before = runtimeIndexObservedHash(table, beforeDefinition, indexes), after = runtimeIndexObservedHash(table, afterDefinition, indexes)
  const value = { id: 'inplace_029_01_usage_strategy_capacity', table,
    sql: 'ALTER TABLE `ai_model_usage_logs` MODIFY COLUMN `strategy_id` BIGINT UNSIGNED NULL DEFAULT NULL', beforeHash: before, afterHash: after }
  return [{ step: { ...value, checksum: sha256(JSON.stringify(value)) }, key: table, before, after, beforeDefinition, afterDefinition, beforeLine, afterLine }]
}
export async function loadUsageStrategyCapacityCoordinator(root) {
  const additions = await usageStrategyCapacityTransitions(root)
  const sql = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/033_usage_strategy_capacity.sql', root), 'utf8'))
  if (JSON.stringify(sql) !== JSON.stringify(additions.map(row => row.step.sql))) throw Error('usage_strategy_sql_drift')
  const prior = await loadFoundationForeignKeyCoordinator(root)
  return { ...prior, steps: [...prior.steps, ...additions.map(row => row.step)], transitions: [...prior.transitions, ...additions] }
}
