import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { inplaceColumnSteps } from './dev-vue-column-upgrade.mjs'
import { schemaFingerprint } from './v4-schema-fingerprint.mjs'

const check = (value, code) => { if (!value) throw new Error(code) }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const quote = value => {
  check(/^[a-z][a-z0-9_]*$/.test(value), 'inplace_identifier_invalid')
  return `\`${value}\``
}

export function validateColumnEvidence(backup, rehearsal) {
  check(backup.kind === 'v4_backup_restore_receipt' && backup.status === 'verified' && backup.source === 'dev_vue'
    && /^dev_vue_m1_source_\d{8}_\d{2}$/.test(backup.target) && backup.parity?.matched === true
    && backup.sqlScopeReviewed === true && backup.decryptionIntegrityVerified === true, 'inplace_backup_receipt_invalid')
  check(rehearsal.kind === 'dev_vue_column_rehearsal' && rehearsal.status === 'verified' && rehearsal.target === backup.target
    && rehearsal.serverUuid === backup.serverUuid && rehearsal.backupSnapshotId === backup.sourceSnapshotId
    && rehearsal.repeatNoop === true && rehearsal.ddlExecutions === inplaceColumnSteps.length
    && rehearsal.scope === 'nine_additive_columns_only', 'inplace_rehearsal_receipt_invalid')
  check(rehearsal.originalColumns.length === backup.parity.tableCount && rehearsal.parity.length === backup.parity.tableCount
    && new Set(rehearsal.originalColumns.map(table => table.name)).size === backup.parity.tableCount
    && new Set(rehearsal.parity.map(table => table.name)).size === backup.parity.tableCount
    && rehearsal.parity.reduce((total, table) => total + BigInt(table.rows), 0n).toString() === backup.parity.rows,
  'inplace_rehearsal_parity_invalid')
}

export async function loadColumnEvidence(root, paths) {
  const [backup, rehearsal, tools] = await Promise.all(paths.map(async path => JSON.parse(await readFile(path, 'utf8'))))
  validateColumnEvidence(backup, rehearsal)
  for (const path of ['server/db/migrations/inplace/001_upgrade_journal.sql', 'server/db/migrations/inplace/002_user_bridge_columns.sql',
    'scripts/lib/dev-vue-column-upgrade.mjs', 'scripts/lib/mysql-inplace-column-store.mjs']) {
    const entries = tools.filter(item => item.path === path)
    check(entries.length === 1 && sha256(await readFile(new URL(path, root))) === entries[0].sha256, 'inplace_rehearsed_code_changed')
  }
  return { backup, rehearsal }
}

// Strip only the nine separately verified additions; preserve all other DDL.
export function originalDefinition(name, ddl) {
  const added = new Set(inplaceColumnSteps.filter(step => step.table === name).map(step => step.column))
  return ddl.split('\n').filter(line => !added.has(/^  `([a-z][a-z0-9_]*)` /.exec(line)?.[1])).join('\n')
}

export async function verifyOriginalSchema(connection, expectedSha256, verifiedAddedTables = []) {
  const [schemas] = await connection.query('SELECT DEFAULT_CHARACTER_SET_NAME charset_name,DEFAULT_COLLATION_NAME collation_name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=DATABASE()')
  const [tables] = await connection.query('SELECT TABLE_NAME name,TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME')
  const definitions = []
  for (const table of tables) {
    if (table.name === 'database_upgrade_steps_v4' || verifiedAddedTables.includes(table.name)) continue
    check(table.type === 'BASE TABLE', 'inplace_original_object_changed')
    const [[row]] = await connection.query(`SHOW CREATE TABLE ${quote(table.name)}`)
    definitions.push({ name: table.name, ddl: originalDefinition(table.name, row['Create Table']) })
  }
  check(schemaFingerprint(schemas[0], definitions).sha256 === expectedSha256, 'inplace_original_schema_changed')
}

export async function readOriginalRows(connection, tables) {
  const result = []
  for (const table of tables) {
    check(table.columns.length > 0 && table.primary.length > 0, 'inplace_original_columns_invalid')
    const hash = createHash('sha256')
    let count = 0
    const stream = connection.connection.query({ sql: `SELECT ${table.columns.map(quote).join(',')} FROM ${quote(table.name)} ORDER BY ${table.primary.map(quote).join(',')}`,
      rowsAsArray: true }).stream({ highWaterMark: 16 })
    for await (const row of stream) { hash.update(JSON.stringify(row)); hash.update('\n'); count++ }
    result.push({ name: table.name, rows: count, sha256: hash.digest('hex') })
  }
  return result
}
