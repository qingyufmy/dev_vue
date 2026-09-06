import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'
import { loadMacroSchemaCoordinator } from './inplace-macro-schema.mjs'
import { verifyOriginalSchema } from './inplace-column-evidence.mjs'

const changes = Object.freeze([
  ['email_verified', 'tinyint', '1'], ['phone_verified', 'tinyint', '0'], ['auth_method', 'varchar(20)', 'email'],
  ['plan_period', 'varchar(20)', ''], ['changelog_seen_version', 'int', '0'],
])

export async function loadUserDefaultsCoordinator(root) {
  const reference = JSON.parse(await readFile(new URL('docs/migration/dev-vue-users-default-reference-20260907.json', root), 'utf8'))
  if (reference.kind !== 'user-default-source-reference/v1' || reference.identity.db !== 'dev_vue'
    || reference.identity.uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104') throw new Error('inplace_user_defaults_reference')
  const statements = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/009_user_state_defaults.sql', root), 'utf8'))
  if (statements.length !== changes.length) throw new Error('inplace_user_defaults_sql')
  const transitions = changes.map(([column, type, defaultValue], index) => {
    const rows = reference.columns.filter(row => row.name === column)
    const row = rows[0]
    if (rows.length !== 1 || row.type !== type || row.nullable !== 'YES' || row.defaultValue !== defaultValue || row.extra !== '') throw new Error('inplace_user_defaults_source')
    const before = { type, nullable: row.nullable, defaultValue, collation: row.collation, extra: row.extra }
    const after = { ...before, defaultValue: null }
    const sql = `ALTER TABLE \`users\` ALTER COLUMN \`${column}\` SET DEFAULT NULL`
    if (statements[index] !== sql) throw new Error('inplace_user_defaults_sql')
    const value = { id: `inplace_008_${String(index + 1).padStart(2, '0')}_${column}`, table: 'users', column, sql, before, after }
    return { step: { ...value, checksum: sha256(JSON.stringify(value)) }, key: `users.${column}`, before, after }
  })
  const prior = await loadMacroSchemaCoordinator(root)
  return { steps: [...prior.steps, ...transitions.map(t => t.step)], transitions: [...prior.transitions, ...transitions], store: prior.store }
}

// Restore ONLY the five reviewed default tokens for the legacy fingerprint.
// The coordinator separately requires the current value to match its journal state.
// All other types, collations, columns, indexes and constraints remain visible.
export function originalUserDefaultDefinition(ddl) {
  let lines = ddl.split('\n')
  for (const [column, , defaultValue] of changes) {
    const matches = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.startsWith(`  \`${column}\` `))
    if (matches.length !== 1) throw new Error('inplace_user_defaults_definition')
    const { line, index } = matches[0]
    const before = `DEFAULT '${defaultValue}'`
    if (line.includes('DEFAULT NULL')) lines[index] = line.replace('DEFAULT NULL', before)
    else if (!line.includes(before)) throw new Error('inplace_user_defaults_definition')
  }
  return lines.join('\n')
}

export function verifyOriginalSchemaWithUserDefaults(connection, hash, excluded) {
  return verifyOriginalSchema({ query: async (...args) => {
    const result = await connection.query(...args)
    if (args[0] !== 'SHOW CREATE TABLE `users`') return result
    return [result[0].map(row => ({ ...row, 'Create Table': originalUserDefaultDefinition(row['Create Table']) })), result[1]]
  } }, hash, excluded)
}
