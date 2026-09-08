import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'
import { loadTemporalPrecisionCoordinator } from './inplace-temporal-precision-schema.mjs'

const scope = {
  ai_model_profiles: { provider: 'varchar(64)', model_name: 'varchar(191)', max_tokens: 'int unsigned', request_timeout_ms: 'int unsigned' },
  platform_model_usage_policy: { daily_requests_per_user: 'int unsigned', daily_tokens_per_user: 'bigint unsigned' },
  ai_model_usage_logs: Object.fromEntries(['token_count', 'request_bytes', 'response_bytes', 'duration_ms', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'cached_tokens'].map(name => [name, 'bigint unsigned'])),
}
export async function modelCapacityTransitions(root) {
  const bytes = await readFile(new URL('docs/migration/dev-vue-model-capacity-source-20260908.json', root))
  if (sha256(bytes) !== 'c76a2d1ad62d225472e72f744b6b6eb6c07abf26c62406db43d883320b5d0d1b') throw Error('model_capacity_source_hash')
  const proof = JSON.parse(bytes)
  if (proof.identity.db !== 'dev_vue' || proof.identity.uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104' || proof.schemaSteps !== 91 || proof.databaseWrites !== 0) throw Error('model_capacity_source_invalid')
  const fields = proof.fields.filter(row => scope[row.table]?.[row.column])
  if (fields.length !== 14) throw Error('model_capacity_scope')
  return fields.map((field, index) => {
    const { table, column, metadata } = field, type = scope[table][column]
    if (field.relations.length || metadata.extra !== '' || !field.targetDeclaration.toLowerCase().startsWith(type + ' ')
      || (type.includes('unsigned') && field.data.negative_count !== '0')) throw Error('model_capacity_precondition')
    const lines = proof.tables.find(row => row.name === table).definition.split('\n').filter(line => line.startsWith(`  \`${column}\` `))
    if (lines.length !== 1 || !lines[0].startsWith(`  \`${column}\` ${metadata.type} `)) throw Error('model_capacity_definition')
    const beforeLine = lines[0], afterLine = beforeLine.replace(`\`${column}\` ${metadata.type} `, `\`${column}\` ${type} `)
    const before = { type: metadata.type, nullable: metadata.nullable, defaultValue: metadata.defaultValue, collation: metadata.collation, extra: metadata.extra }
    const after = { ...before, type }
    const sql = `ALTER TABLE \`${table}\` MODIFY COLUMN ${afterLine.trim().replace(/,$/, '')}`
    const value = { id: `inplace_023_${String(index + 1).padStart(2, '0')}_${table}_${column}`, table, column, sql, before, after, beforeLine, afterLine }
    return { step: { ...value, checksum: sha256(JSON.stringify(value)) }, key: `${table}.${column}`, before, after }
  })
}
export async function loadModelCapacityCoordinator(root) {
  const additions = await modelCapacityTransitions(root)
  const sql = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/027_model_capacity_types.sql', root), 'utf8'))
  if (JSON.stringify(sql) !== JSON.stringify(additions.map(row => row.step.sql))) throw Error('model_capacity_sql_drift')
  const prior = await loadTemporalPrecisionCoordinator(root)
  return { ...prior, steps: [...prior.steps, ...additions.map(row => row.step)], transitions: [...prior.transitions, ...additions] }
}
export function originalCapacityDefinition(name, ddl, transitions) {
  const lines = ddl.split('\n')
  for (const { step } of transitions.filter(row => row.step.table === name)) {
    const positions = lines.flatMap((line, index) => line.startsWith(`  \`${step.column}\` `) ? [index] : [])
    if (positions.length !== 1 || ![step.beforeLine, step.afterLine].includes(lines[positions[0]])) throw Error('model_capacity_definition_changed')
    lines[positions[0]] = step.beforeLine
  }
  return lines.join('\n')
}
