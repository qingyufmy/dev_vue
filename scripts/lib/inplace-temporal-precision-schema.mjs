import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'
import { loadIndependentStructureCoordinator } from './inplace-independent-structure-schema.mjs'

export async function temporalPrecisionTransitions(root) {
  const bytes = await readFile(new URL('docs/migration/dev-vue-type-data-review-20260908.json', root))
  if (sha256(bytes) !== '7da7afdbc36be62ad6300599b9ae6b9455e27e8ac4b43dc9fa9d3a3545473eab') throw Error('temporal_precision_source_hash')
  const proof = JSON.parse(bytes)
  if (proof.identity.db !== 'dev_vue' || proof.identity.uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104'
    || proof.databaseWrites !== 0 || proof.schemaSteps !== 75 || proof.summary.incompleteDateFields.length) throw Error('temporal_precision_source_invalid')
  const fields = proof.fields.filter(row => row.category === 'datetime_precision')
  if (fields.length !== 16 || new Set(fields.map(row => row.table)).size !== 6) throw Error('temporal_precision_scope')
  return fields.map((field, index) => {
    const { table, column, metadata } = field
    if (!/^[a-z][a-z0-9_]*$/.test(table) || !/^[a-z][a-z0-9_]*$/.test(column) || metadata.type !== 'datetime'
      || metadata.collation !== null || !['', 'DEFAULT_GENERATED'].includes(metadata.extra)
      || ![null, 'now()'].includes(metadata.defaultValue)) throw Error('temporal_precision_column')
    const lines = proof.tables.find(row => row.name === table)?.definition.split('\n').filter(line => line.startsWith(`  \`${column}\` `))
    if (lines?.length !== 1) throw Error('temporal_precision_definition')
    const beforeLine = lines[0], afterLine = beforeLine.replace(' datetime ', ' datetime(3) ').replace('DEFAULT (now())', 'DEFAULT (now(3))')
    const before = { type: metadata.type, nullable: metadata.nullable, defaultValue: metadata.defaultValue, collation: null, extra: metadata.extra }
    const after = { ...before, type: 'datetime(3)', defaultValue: metadata.defaultValue === 'now()' ? 'now(3)' : null }
    const sql = `ALTER TABLE \`${table}\` MODIFY COLUMN ${afterLine.trim().replace(/,$/, '')}`
    const value = { id: `inplace_022_${String(index + 1).padStart(2, '0')}_${table}_${column}`, table, column, sql, before, after, beforeLine, afterLine }
    const step = { ...value, checksum: sha256(JSON.stringify(value)) }
    return { step, key: `${table}.${column}`, before, after }
  })
}

export async function loadTemporalPrecisionCoordinator(root) {
  const additions = await temporalPrecisionTransitions(root)
  const sql = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/026_utc_datetime_precision.sql', root), 'utf8'))
  if (JSON.stringify(sql) !== JSON.stringify(additions.map(row => row.step.sql))) throw Error('temporal_precision_sql_drift')
  const prior = await loadIndependentStructureCoordinator(root)
  return { ...prior, steps: [...prior.steps, ...additions.map(row => row.step)], transitions: [...prior.transitions, ...additions] }
}

export function originalTemporalDefinition(name, ddl, transitions) {
  const applicable = transitions.filter(row => row.step.table === name)
  const lines = ddl.split('\n')
  for (const { step } of applicable) {
    const positions = lines.flatMap((line, index) => line.startsWith(`  \`${step.column}\` `) ? [index] : [])
    if (positions.length !== 1 || ![step.beforeLine, step.afterLine].includes(lines[positions[0]])) throw Error('temporal_precision_definition_changed')
    lines[positions[0]] = step.beforeLine
  }
  return lines.join('\n')
}
