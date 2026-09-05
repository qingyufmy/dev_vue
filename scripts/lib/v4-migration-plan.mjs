import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export const BOOTSTRAP_ID = 'bootstrap_v4_foundation_v1'
export const sha256 = value => createHash('sha256').update(value).digest('hex')
export class V4SchemaMigrationError extends Error {
  constructor(code, details = {}) { super(code); this.code = code; this.details = details }
}
export function requireMigration(condition, code, details) {
  if (!condition) throw new V4SchemaMigrationError(code, details)
}
export function validateDatabaseIdentifier(name) {
  requireMigration(typeof name === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(name), 'migration_database_invalid')
  return name
}

// Only these previously reviewed, file-bound data transformations are allowed.
const approvedDml = {
  '20260903_005_analysis_scheduler_and_account_fanout': ['cc93fa43f977f7bcae3a2e479b085fbbe1cc1dd1a6821e92534ec1653e1d8a83'],
  '20260905_022_observer_management_ledger': ['d5f205b290811a4f861fe7b3e57aff74964c12bb9ce6d2dbc9bca039d8b793e3'],
  '20260903_007_deterministic_risk_review': [
    'c110c61c1be8f1bd62aac99992792cc7db2c8dd7c2570d0e3208c6530aa9ae0f',
    '2c12bafb983025bc542ae4845144647d71f3c7bd8aece7e5973b5cc15b0449ef',
    'f8a8f16272ff93871b312e14135a17eb2fee653effcbf0cb0082ddfc1ff921a6',
    'e633528bab54918a16844f9839699afbea75191c20a679f47c44ebc1a48d3ab0',
    'daa5edf94f1b67095b907ec77dfc93ea3de5ac06152b0a3feb07406552da383f',
    '747bd8457a4dedc14900e8a83778182b116cb1dfd7f185c1b95cf5bb3616d65e',
  ],
  '20260903_008_manual_risk_release': [
    '70197033c39b658d4ab1c34c9158579d0d05c20b74256eefd6b7629cff91d384',
    '56f4603315006920ebdaaae7ec019045335acf3a8a2a74ef105edb6dd1b3d1f0',
    '154a2886a6d69c4f32c79e3fba2515a85d938a20854ba3a48de27332a739be70',
    '3654ea481f6e7a5bbcfca22e4c893de92dfbac54d74143dac1c097791b799c90',
    'a9b0d22af7b62111db9c19d16e38339b582bcca4882266a02a0ac6d6d5468f67',
    'ceec68a5d68d0e89354774fb4c1b5d153db5983e60b7760b6afa062235c1f55a',
  ],
}

export async function loadMigrationPlan({ rootDirectory }) {
  const directory = join(rootDirectory, 'server/db/migrations')
  const names = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()
  names.forEach((name, index) => {
    const match = /^(\d{8})_(\d{3})_[a-z0-9_]+\.sql$/.exec(name)
    requireMigration(match && Number(match[2]) === index + 1, 'migration_sequence_invalid', { file: name })
  })
  requireMigration(names.length > 0, 'migration_plan_empty')
  const files = [{ id: BOOTSTRAP_ID, file: 'bootstrap/v4-foundation-v1.sql' }, ...names.map(file => ({ id: file.slice(0, -4), file }))]
  return Object.freeze(await Promise.all(files.map(async ({ id, file }) => {
    const raw = await readFile(join(directory, file))
    const statements = splitSqlStatements(raw.toString('utf8'))
    for (const statement of statements) validateMigrationStatement(statement, id)
    return Object.freeze({ id, file, checksum: sha256(raw), statements: Object.freeze(statements) })
  })))
}

export function splitSqlStatements(input) {
  requireMigration(typeof input === 'string' && !input.includes('\0'), 'migration_sql_invalid')
  const source = input.replace(/\r\n/g, '\n')
  const statements = []
  let buffer = '', quote = null
  for (let i = 0; i < source.length; i++) {
    const c = source[i], next = source[i + 1]
    if (quote) {
      buffer += c
      if (c === '\\' && quote !== '`') { buffer += source[++i] ?? ''; continue }
      if (c === quote) {
        if (next === quote) buffer += source[++i]
        else quote = null
      }
    } else if (c === "'" || c === '"' || c === '`') { quote = c; buffer += c }
    else if ((c === '-' && next === '-' && /\s|^$/.test(source[i + 2] ?? '')) || c === '#') {
      const end = source.indexOf('\n', i)
      i = end < 0 ? source.length : end - 1
      buffer += ' '
    } else if (c === '/' && next === '*') {
      requireMigration(!['!', '+', 'M'].includes(source[i + 2]), 'migration_executable_comment')
      const end = source.indexOf('*/', i + 2)
      requireMigration(end >= 0, 'migration_comment_unterminated')
      i = end + 1; buffer += ' '
    } else if (c === ';') { if (buffer.trim()) statements.push(buffer.trim()); buffer = '' }
    else buffer += c
  }
  requireMigration(!quote, 'migration_quote_unterminated')
  if (buffer.trim()) statements.push(buffer.trim())
  requireMigration(statements.length > 0, 'migration_sql_empty')
  return statements
}

export function validateMigrationStatement(statement, id) {
  if (approvedDml[id]?.includes(sha256(statement))) return
  const masked = statement.replace(/'(?:\\.|''|[^'])*'|"(?:\\.|""|[^"])*"/gs, "''")
  requireMigration(/^(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE)\s+`?[a-z][a-z0-9_]*`?\s/i.test(masked), 'migration_statement_unapproved', { id })
  requireMigration(!/[a-z0-9_`]+\s*\.\s*[a-z0-9_`]+/i.test(masked), 'migration_qualified_identifier', { id })
  requireMigration(!/\b(?:SELECT|LIKE|RENAME|DATABASE|SCHEMA|OUTFILE|INFILE|DIRECTORY|TABLESPACE|PROCEDURE|TRIGGER)\b/i.test(masked), 'migration_statement_unapproved', { id })
  requireMigration(!/ENGINE\s*=\s*(?!InnoDB\b)\w+/i.test(masked), 'migration_engine_unapproved', { id })
}

export function createdTables(migrations) {
  return migrations.flatMap(migration => migration.statements.flatMap(statement => {
    const match = /^CREATE TABLE(?: IF NOT EXISTS)?\s+`?([a-z][a-z0-9_]*)`?\s/i.exec(statement)
    return match ? [match[1]] : []
  }))
}
