import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'
import { loadModelCapacityCoordinator } from './inplace-model-capacity-schema.mjs'

const keys = ['ai_model_usage_logs.id', 'trading_accounts.broker_server', 'users.nickname', 'users.avatar', 'users.role', 'users.plan', 'users.created_at', 'users.updated_at', 'trading_accounts.margin_mode']
export async function columnConstraintTransitions(root) {
  const bytes = await readFile(new URL('docs/migration/dev-vue-column-constraints-source-20260908.json', root))
  if (sha256(bytes) !== '6c5f05c1892fafd2b8f5762c0333921d7a4cb79b9c1fe14118e6153cca923888') throw Error('column_constraints_source_hash')
  const proof = JSON.parse(bytes)
  if (proof.identity.db !== 'dev_vue' || proof.identity.uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104' || proof.schemaSteps !== 105 || proof.databaseWrites !== 0) throw Error('column_constraints_source_invalid')
  return keys.map((key, index) => {
    const fields = proof.fields.filter(row => `${row.table}.${row.column}` === key)
    if (fields.length !== 1) throw Error('column_constraints_scope')
    const field = fields[0], { table, column, metadata } = field
    if (field.relations.some(row => row.parent_table !== null)) throw Error('column_constraints_foreign_key')
    const lines = proof.tables.find(row => row.name === table).definition.split('\n').filter(line => line.startsWith(`  \`${column}\` `))
    if (lines.length !== 1) throw Error('column_constraints_definition')
    const beforeLine = lines[0]
    const before = { type: metadata.type, nullable: metadata.nullable, defaultValue: metadata.defaultValue, collation: metadata.collation, extra: metadata.extra }
    let after = { ...before }, afterLine = beforeLine
    if (table === 'users') {
      if (before.nullable !== 'YES' || field.data.null_count !== '0' || !beforeLine.includes(' DEFAULT ')) throw Error('column_constraints_null')
      after.nullable = 'NO'; afterLine = beforeLine.replace(' DEFAULT ', ' NOT NULL DEFAULT ')
    } else if (key === 'ai_model_usage_logs.id') {
      if (before.type !== 'bigint' || field.data.negative_count !== '0' || BigInt(field.data.min_value) < 1n || before.extra !== 'auto_increment') throw Error('column_constraints_id')
      after.type = 'bigint unsigned'; afterLine = beforeLine.replace(' bigint ', ' bigint unsigned ')
    } else if (column === 'broker_server') {
      if (before.type !== 'varchar(100)') throw Error('column_constraints_capacity')
      after.type = 'varchar(191)'; afterLine = beforeLine.replace(' varchar(100) ', ' varchar(191) ')
    } else {
      if (before.type !== 'varchar(20)' || before.nullable !== 'NO' || before.defaultValue !== 'netting') throw Error('column_constraints_margin')
      after.nullable = 'YES'; after.defaultValue = null
      afterLine = beforeLine.replace(" NOT NULL DEFAULT 'netting'", ' DEFAULT NULL')
    }
    const sql = `ALTER TABLE \`${table}\` MODIFY COLUMN ${afterLine.trim().replace(/,$/, '')}`
    const value = { id: `inplace_024_${String(index + 1).padStart(2, '0')}_${table}_${column}`, table, column, sql, before, after, beforeLine, afterLine }
    return { step: { ...value, checksum: sha256(JSON.stringify(value)) }, key, before, after }
  })
}
export async function loadColumnConstraintsCoordinator(root) {
  const additions = await columnConstraintTransitions(root)
  const sql = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/028_existing_column_constraints.sql', root), 'utf8'))
  if (JSON.stringify(sql) !== JSON.stringify(additions.map(row => row.step.sql))) throw Error('column_constraints_sql_drift')
  const prior = await loadModelCapacityCoordinator(root)
  return { ...prior, steps: [...prior.steps, ...additions.map(row => row.step)], transitions: [...prior.transitions, ...additions] }
}
