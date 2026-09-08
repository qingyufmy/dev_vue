import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { loadModelCheckCoordinator } from './inplace-model-check-schema.mjs'

const indexes = [
  ['bridge_refresh_sessions', 'uk_bridge_refresh_migration_key', true, ['migration_key']],
  ['bridge_refresh_sessions', 'uk_bridge_refresh_source_migration', true, ['source_refresh_session_id']],
  ['bridge_refresh_sessions', 'idx_bridge_refresh_device', false, ['user_id', 'installation_id', 'profile_id', 'credential_version', 'revoked_at', 'expires_at']],
  ['ai_model_profiles', 'idx_v4_model_profiles_owner', false, ['owner_user_id', 'scope', 'status', 'deleted_at', 'id']],
  ['ai_model_usage_logs', 'idx_v4_model_usage_quota', false, ['user_id', 'credential_source', 'created_at', 'request_phase']],
  ['ai_model_usage_logs', 'idx_v4_model_usage_recovery', false, ['request_status', 'created_at', 'id']],
]
export async function runtimeIndexTransitions(root) {
  const bytes = await readFile(new URL('docs/migration/dev-vue-runtime-index-source-20260908.json', root))
  if (sha256(bytes) !== '861f4c9eef3b059852cd61a72904f06a1926fb321f3766c2cadc65a98e58ef90') throw Error('runtime_index_source_hash')
  const source = JSON.parse(bytes)
  if (source.schemaSteps !== 133 || source.databaseWrites !== 0 || source.duplicates.length !== 2
    || source.duplicates.some(row => row.duplicate_groups !== '0')) throw Error('runtime_index_source_invalid')
  const definitions = new Map(source.definitions.map(row => [row.name, row.sql]))
  return indexes.map(([table, name, unique, columns], index) => {
    const beforeDefinition = definitions.get(table), lines = beforeDefinition.split('\n')
    if (lines.some(line => line.includes('`' + name + '`'))) throw Error('runtime_index_exists')
    const declaration = `${unique ? 'UNIQUE ' : ''}KEY \`${name}\` (${columns.map(column => `\`${column}\``).join(',')})`
    let position = lines.findIndex(line => line.startsWith('  CONSTRAINT '))
    if (position < 0) position = lines.findIndex(line => line.startsWith(') ENGINE='))
    if (position < 1) throw Error('runtime_index_definition')
    const indexLine = '  ' + declaration + (lines[position].startsWith('  CONSTRAINT ') ? ',' : '')
    if (!lines[position - 1].endsWith(',')) lines[position - 1] += ','
    lines.splice(position, 0, indexLine)
    const afterDefinition = lines.join('\n'); definitions.set(table, afterDefinition)
    const before = tableDefinitionHash(beforeDefinition), after = tableDefinitionHash(afterDefinition)
    const value = { id: `inplace_027_0${index + 1}_${name}`, table, sql: `ALTER TABLE \`${table}\` ADD ${declaration}`, beforeHash: before, afterHash: after }
    return { step: { ...value, checksum: sha256(JSON.stringify(value)) }, key: table, before, after, beforeDefinition, afterDefinition, indexLine }
  })
}
export function removeRuntimeIndexDefinitions(name, ddl, transitions) {
  for (const transition of transitions.filter(row => row.step.table === name).toReversed()) {
    const lines = ddl.split('\n'), expected = transition.indexLine.replace(/,$/, '')
    const index = lines.findIndex(line => line.replace(/,$/, '') === expected)
    if (index < 0) continue
    if (lines[index + 1]?.startsWith(') ENGINE=')) lines[index - 1] = lines[index - 1].replace(/,$/, '')
    lines.splice(index, 1); ddl = lines.join('\n')
  }
  return ddl
}
// MySQL renders UNIQUE before ordinary indexes. Keep immutable journal hashes
// and normalize only the display order of these six exact index descriptors.
export function runtimeIndexObservedHash(name, ddl, transitions) {
  const added = transitions.filter(row => row.step.table === name)
  if (!added.length) return tableDefinitionHash(ddl)
  const lines = ddl.split('\n'), moved = []
  for (const row of added) {
    const descriptor = row.indexLine.replace(/,$/, '')
    const positions = lines.flatMap((line, index) => line.replace(/,$/, '') === descriptor ? [index] : [])
    if (positions.length > 1) throw Error('runtime_index_duplicate_descriptor')
    if (positions.length) { moved.push(descriptor); lines.splice(positions[0], 1) }
  }
  if (moved.length) {
    let index = lines.findIndex(line => line.startsWith('  CONSTRAINT '))
    if (index < 0) index = lines.findIndex(line => line.startsWith(') ENGINE='))
    if (index < 1) throw Error('runtime_index_layout')
    const hasConstraints = lines[index].startsWith('  CONSTRAINT ')
    lines[index - 1] = lines[index - 1].replace(/,$/, '') + ','
    lines.splice(index, 0, ...moved.map((line, i) => line + (hasConstraints || i < moved.length - 1 ? ',' : '')))
  }
  return tableDefinitionHash(lines.join('\n'))
}
export async function loadRuntimeIndexCoordinator(root) {
  const additions = await runtimeIndexTransitions(root)
  const sql = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/031_runtime_query_indexes.sql', root), 'utf8'))
  if (JSON.stringify(sql) !== JSON.stringify(additions.map(row => row.step.sql))) throw Error('runtime_index_sql_drift')
  const prior = await loadModelCheckCoordinator(root)
  return { ...prior, steps: [...prior.steps, ...additions.map(row => row.step)], transitions: [...prior.transitions, ...additions],
    store(connection) {
      const base = prior.store(connection)
      return { ...base, async tableHash(name) {
        if (!indexes.some(row => row[0] === name)) return base.tableHash(name)
        const [[row]] = await connection.query(`SHOW CREATE TABLE \`${name}\``)
        return runtimeIndexObservedHash(name, row['Create Table'], additions)
      } }
    } }
}
