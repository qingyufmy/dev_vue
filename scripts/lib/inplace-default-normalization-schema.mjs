import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'
import { defaultNormalizationScope } from './default-normalization-scope.mjs'
import { loadColumnConstraintsCoordinator } from './inplace-column-constraints-schema.mjs'

export async function defaultNormalizationTransitions(root) {
  const bytes = await readFile(new URL('docs/migration/dev-vue-default-normalization-source-20260908.json', root))
  if (sha256(bytes) !== '20fa2582ba1375833ad4277b6890a44018f2f47ccf2c5e9688a30cd182db8b1a') throw Error('default_normalization_source_hash')
  const proof = JSON.parse(bytes)
  if (proof.identity.db !== 'dev_vue' || proof.identity.uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104' || proof.schemaSteps !== 114 || proof.databaseWrites !== 0) throw Error('default_normalization_source_invalid')
  const keys = Object.entries(defaultNormalizationScope).flatMap(([table, columns]) => columns.map(column => `${table}.${column}`))
  if (keys.length !== 16 || JSON.stringify(keys) !== JSON.stringify(proof.fields.map(row => `${row.table}.${row.column}`))) throw Error('default_normalization_scope')
  const values = proof.fields.map(field => {
    const { table, column, metadata, target } = field
    if (metadata.extra !== '' || metadata.defaultValue === target || target !== null && !/^[a-z0-9_]+$/.test(target)) throw Error('default_normalization_value')
    const before = { ...metadata }, after = { ...metadata, defaultValue: target }
    const lines = proof.definitions.find(row => row.name === table).definition.split('\n').filter(line => line.startsWith(`  \`${column}\` `))
    if (lines.length !== 1 || !/ DEFAULT (?:NULL|'(?:''|[^'])*'),$/.test(lines[0])) throw Error('default_normalization_definition')
    const drop = target === null && metadata.nullable === 'NO'
    const literal = target === null ? 'NULL' : `'${target}'`
    const beforeLine = lines[0], afterLine = beforeLine.replace(/ DEFAULT (?:NULL|'(?:''|[^'])*'),$/, drop ? ',' : ` DEFAULT ${literal},`)
    const sql = `ALTER TABLE \`${table}\` ALTER COLUMN \`${column}\` ${drop ? 'DROP DEFAULT' : `SET DEFAULT ${literal}`}`
    return { table, column, before, after, beforeLine, afterLine, sql }
  })
  const token = proof.tokenHash, column = 'token_hash', table = 'bridge_refresh_sessions'
  if (token.invalid !== '0' || token.metadata.type !== 'char(64)' || token.metadata.nullable !== 'NO'
    || token.metadata.defaultValue !== null || token.metadata.extra !== '' || token.metadata.collation !== 'utf8mb4_0900_ai_ci') throw Error('default_normalization_token_source')
  const lines = token.definition.split('\n').filter(line => line.startsWith('  `token_hash` '))
  if (lines.length !== 1 || lines[0] !== '  `token_hash` char(64) NOT NULL,') throw Error('default_normalization_token_definition')
  const beforeLine = lines[0], afterLine = '  `token_hash` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,'
  values.push({ table, column, before: token.metadata, after: { ...token.metadata, collation: 'ascii_bin' }, beforeLine, afterLine,
    sql: 'ALTER TABLE `bridge_refresh_sessions` MODIFY COLUMN `token_hash` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL' })
  return values.map((value, index) => {
    const row = { id: `inplace_025_${String(index + 1).padStart(2, '0')}_${value.table}_${value.column}`, ...value }
    return { step: { ...row, checksum: sha256(JSON.stringify(row)) }, key: `${value.table}.${value.column}`, before: value.before, after: value.after }
  })
}
export async function loadDefaultNormalizationCoordinator(root) {
  const additions = await defaultNormalizationTransitions(root)
  const sql = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/029_defaults_and_token_hash.sql', root), 'utf8'))
  if (JSON.stringify(sql) !== JSON.stringify(additions.map(row => row.step.sql))) throw Error('default_normalization_sql_drift')
  const prior = await loadColumnConstraintsCoordinator(root)
  return { ...prior, steps: [...prior.steps, ...additions.map(row => row.step)], transitions: [...prior.transitions, ...additions] }
}
