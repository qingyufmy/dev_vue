import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { mysqlColumnStore, verifyInplaceJournal, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { loadFoundationSteps, executeFoundationSteps, withTableInspection, foundationNames } from './lib/inplace-foundation-upgrade.mjs'
import { readOriginalRows, verifyOriginalSchema, validateColumnEvidence } from './lib/inplace-column-evidence.mjs'

const root = new URL('../', import.meta.url)
const check = (value, code) => { if (!value) throw new Error(code) }
let connection
try {
  const args = process.argv.slice(2), apply = args[0] === '--apply'
  check((args.length === 1 && args[0] === '--plan') || (args.length === 5 && apply), 'inplace_foundation_arguments')
  const steps = await loadFoundationSteps(root)
  let backup, columns
  if (apply) {
    const evidence = await Promise.all(args.slice(1).map(async path => JSON.parse(await readFile(path, 'utf8'))))
    ;[backup, columns] = evidence
    const [, , rehearsal, tools] = evidence
    validateColumnEvidence(backup, columns)
    check(rehearsal.kind === 'dev_vue_foundation_rehearsal' && rehearsal.status === 'verified'
      && rehearsal.target === backup.target && rehearsal.serverUuid === backup.serverUuid && rehearsal.backupSnapshotId === backup.sourceSnapshotId
      && rehearsal.repeatNoop === true && rehearsal.noBusinessRowsSeeded === true
      && JSON.stringify(rehearsal.stepChecksums) === JSON.stringify(steps.map(({ id, checksum, expectedHash }) => ({ id, checksum, expectedHash }))), 'inplace_foundation_evidence_invalid')
    for (const path of ['scripts/lib/inplace-foundation-upgrade.mjs', 'scripts/lib/inplace-column-evidence.mjs',
      'scripts/lib/dev-vue-column-upgrade.mjs', 'scripts/lib/mysql-inplace-column-store.mjs', 'server/db/migrations/inplace/003_identity_migration_tables.sql']) {
      const entries = tools.filter(item => item.path === path)
      check(entries.length === 1 && createHash('sha256').update(await readFile(new URL(path, root))).digest('hex') === entries[0].sha256, 'inplace_rehearsed_code_changed')
    }
  }
  const env = parse(await readFile(new URL('server/.env', root)))
  check(env.MYSQL_DATABASE === 'dev_vue', 'inplace_database_mismatch')
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, timezone: 'Z', dateStrings: true, jsonStrings: true,
    connectTimeout: 5000, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false })
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('SET SESSION autocommit=1')
  await connection.query('SET SESSION lock_wait_timeout=10')
  const report = await withInplaceUpgradeLock(connection, 'dev_vue', async () => {
    const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
    check(identity.db === 'dev_vue' && (!apply || identity.uuid === backup.serverUuid), 'inplace_instance_mismatch')
    check(await verifyInplaceJournal(connection), 'inplace_columns_required')
    const store = withTableInspection(connection, mysqlColumnStore(connection, true))
    const planned = await executeFoundationSteps(store, steps)
    for (const step of steps) for (const match of step.sql.matchAll(/CONSTRAINT `([a-z][a-z0-9_]*)`/g)) {
      const [rows] = await connection.execute('SELECT TABLE_NAME name FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_NAME=?', [match[1]])
      check(rows.every(row => row.name === step.table), 'inplace_constraint_name_conflict')
    }
    if (!apply) return { ...planned, database: identity.db }
    await verifyOriginalSchema(connection, backup.schemaSha256, foundationNames)
    const before = await readOriginalRows(connection, columns.originalColumns)
    check(JSON.stringify(before) === JSON.stringify(columns.parity), 'inplace_source_changed_since_backup')
    const result = await executeFoundationSteps(store, steps, { apply: true })
    await verifyOriginalSchema(connection, backup.schemaSha256, foundationNames)
    const after = await readOriginalRows(connection, columns.originalColumns)
    check(JSON.stringify(before) === JSON.stringify(after), 'inplace_original_data_changed')
    return { ...result, database: identity.db, serverUuid: identity.uuid, originalTablesVerified: after.length,
      originalRowsVerified: after.reduce((total, table) => total + BigInt(table.rows), 0n).toString(),
      backupSnapshotId: backup.sourceSnapshotId, completedAtUtc: new Date().toISOString(), dataPreserved: true,
      fullNormalizationComplete: false }
  })
  console.log(JSON.stringify(report))
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? (/^inplace_[a-z_]+$/.test(error.message) ? error.message : 'inplace_foundation_failed') }))
  process.exitCode = 1
} finally { if (connection) await connection.end().catch(() => {}) }
