import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'
import { loadRuntimeIndexCoordinator, runtimeIndexTransitions, runtimeIndexObservedHash } from './inplace-runtime-index-schema.mjs'

export const foundationForeignKeys = [
  ['bridge_refresh_sessions', 'user_id', 'users', 'fk_v4_bridge_refresh_user', false],
  ['user_model_defaults', 'model_profile_id', 'ai_model_profiles', 'fk_v4_model_default_profile', false],
  ['ai_model_provider_capabilities', 'model_profile_id', 'ai_model_profiles', 'fk_v4_capabilities_profile', false],
  ['ai_model_provider_capabilities', 'verified_by_user_id', 'users', 'fk_v4_capabilities_verifier', true],
  ['ai_model_usage_logs', 'model_profile_id', 'ai_model_profiles', 'fk_v4_model_usage_profile', true],
]
export async function foundationForeignKeyTransitions(root) {
  const bytes = await readFile(new URL('docs/migration/dev-vue-foundation-foreign-key-source-20260908.json', root))
  if (sha256(bytes) !== '7ed5734e78c4640dab0463c4eff1fed182bbe015dafc41f82febc460ee0ea10f') throw Error('foundation_fk_source_hash')
  const source = JSON.parse(bytes), priorIndexes = await runtimeIndexTransitions(root)
  if (source.schemaSteps !== 139 || source.databaseWrites !== 0) throw Error('foundation_fk_source_invalid')
  const definitions = new Map(source.definitions.map(row => [row.name, row.sql]))
  return foundationForeignKeys.map(([table, column, parent, name, autoIndex], i) => {
    if (source.relations.find(row => row.table === table && row.column === column && row.parent === parent)?.orphans !== '0') throw Error('foundation_fk_orphans')
    const beforeDefinition = definitions.get(table), lines = beforeDefinition.split('\n')
    const constraint = `  CONSTRAINT \`${name}\` FOREIGN KEY (\`${column}\`) REFERENCES \`${parent}\` (\`id\`)`
    const indexLine = autoIndex ? `  KEY \`${name}\` (\`${column}\`)` : null
    if (lines.some(line => line.includes('`' + name + '`'))) throw Error('foundation_fk_exists')
    if (indexLine) {
      let position = lines.findIndex(line => line.startsWith('  CONSTRAINT '))
      if (position < 0) position = lines.findIndex(line => line.startsWith(') ENGINE='))
      lines[position - 1] = lines[position - 1].replace(/,$/, '') + ','
      lines.splice(position, 0, indexLine + (lines[position].startsWith('  CONSTRAINT ') ? ',' : ''))
    }
    const end = lines.findIndex(line => line.startsWith(') ENGINE='))
    if (end < 1) throw Error('foundation_fk_definition')
    lines[end - 1] = lines[end - 1].replace(/,$/, '') + ','
    lines.splice(end, 0, constraint)
    const afterDefinition = lines.join('\n'); definitions.set(table, afterDefinition)
    const before = runtimeIndexObservedHash(table, beforeDefinition, priorIndexes), after = runtimeIndexObservedHash(table, afterDefinition, priorIndexes)
    const value = { id: `inplace_028_0${i + 1}_${name}`, table, sql: `ALTER TABLE \`${table}\` ADD ${constraint.trim()}`, beforeHash: before, afterHash: after }
    return { step: { ...value, checksum: sha256(JSON.stringify(value)) }, key: table, before, after, beforeDefinition, afterDefinition, addedLines: [indexLine, constraint].filter(Boolean) }
  })
}
export function removeFoundationForeignKeyDefinitions(name, ddl, transitions) {
  for (const row of transitions.filter(item => item.step.table === name).toReversed()) for (const descriptor of row.addedLines.toReversed()) {
    const lines = ddl.split('\n'), index = lines.findIndex(line => line.replace(/,$/, '') === descriptor)
    if (index < 0) continue
    if (lines[index + 1]?.startsWith(') ENGINE=')) lines[index - 1] = lines[index - 1].replace(/,$/, '')
    lines.splice(index, 1); ddl = lines.join('\n')
  }
  return ddl
}
export async function loadFoundationForeignKeyCoordinator(root) {
  const additions = await foundationForeignKeyTransitions(root), priorIndexes = await runtimeIndexTransitions(root)
  const sql = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/032_foundation_foreign_keys.sql', root), 'utf8'))
  if (JSON.stringify(sql) !== JSON.stringify(additions.map(row => row.step.sql))) throw Error('foundation_fk_sql_drift')
  const prior = await loadRuntimeIndexCoordinator(root)
  return { ...prior, steps: [...prior.steps, ...additions.map(row => row.step)], transitions: [...prior.transitions, ...additions],
    store(connection) {
      const base = prior.store(connection)
      return { ...base, async tableHash(name) {
        if (!foundationForeignKeys.some(row => row[0] === name)) return base.tableHash(name)
        const [[row]] = await connection.query(`SHOW CREATE TABLE \`${name}\``)
        return runtimeIndexObservedHash(name, row['Create Table'], priorIndexes)
      } }
    } }
}
