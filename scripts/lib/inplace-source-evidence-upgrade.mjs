import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements, validateMigrationStatement } from './v4-migration-plan.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { executeAccountBuild, inspectAccountBuild } from './inplace-account-build.mjs'

export const sourceEvidenceTable = 'data_migration_source_rows'
export async function loadSourceEvidenceStep(root) {
  const statements = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/005_source_row_evidence.sql', root), 'utf8'))
  if (statements.length !== 1 || !statements[0].startsWith(`CREATE TABLE \`${sourceEvidenceTable}\` (`)) throw new Error('inplace_source_evidence_plan_invalid')
  const sql = statements[0]
  validateMigrationStatement(sql, 'inplace_source_evidence')
  const expectedHash = tableDefinitionHash(sql)
  return { id: 'inplace_004_01_data_migration_source_rows', table: sourceEvidenceTable, sql, expectedHash,
    checksum: sha256(JSON.stringify({ sql, expectedHash })) }
}
export function inspectSourceEvidence(connection, store) {
  const base = inspectAccountBuild(connection, store)
  return { ...base, async tableHash(name) {
    if (name !== sourceEvidenceTable) return base.tableHash(name)
    const [tables] = await connection.execute('SELECT TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [name])
    if (!tables.length) return null
    if (tables[0].type !== 'BASE TABLE') throw new Error('inplace_source_evidence_table_conflict')
    const [triggers] = await connection.execute('SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', [name])
    if (triggers.length) throw new Error('inplace_source_evidence_trigger_conflict')
    const [[row]] = await connection.query(`SHOW CREATE TABLE \`${sourceEvidenceTable}\``)
    return tableDefinitionHash(row['Create Table'])
  } }
}
export async function executeSourceEvidence(store, foundation, build, evidence, options = {}) {
  const history = await store.history()
  if (!build.every(step => history.some(row => row.id === step.id && row.status === 'completed'))) throw new Error('inplace_account_build_required')
  return executeAccountBuild(store, foundation, [...build, evidence], options)
}
