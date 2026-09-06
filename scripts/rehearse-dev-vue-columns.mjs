import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { executeColumnSteps, inplaceColumnSteps } from './lib/dev-vue-column-upgrade.mjs'
import { mysqlColumnStore, verifyInplaceJournal, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { readSchemaFingerprint } from './lib/v4-schema-fingerprint.mjs'
import { splitSqlStatements } from './lib/v4-migration-plan.mjs'

const requireValue = (value, code) => { if (!value) throw new Error(code) }
const quote = value => {
  requireValue(/^[a-z][a-z0-9_]*$/.test(value), 'inplace_identifier_invalid')
  return `\`${value}\``
}

// Stream every original column, including generated/invisible columns. No row payload is logged.
async function originalRows(connection, tables) {
  const result = []
  for (const table of tables) {
    const hash = createHash('sha256')
    let count = 0
    const stream = connection.connection.query({ sql: `SELECT ${table.columns.map(quote).join(',')} FROM ${quote(table.name)} ORDER BY ${table.primary.map(quote).join(',')}`,
      rowsAsArray: true }).stream({ highWaterMark: 16 })
    for await (const row of stream) { hash.update(JSON.stringify(row)); hash.update('\n'); count++ }
    result.push({ name: table.name, rows: count, sha256: hash.digest('hex') })
  }
  return result
}

let connection
try {
  const [receiptPath, outputPath] = process.argv.slice(2)
  requireValue(process.argv.length === 4 && process.platform === 'linux' && process.getuid() === 0, 'inplace_rehearsal_arguments')
  const backup = JSON.parse(await readFile(receiptPath, 'utf8'))
  requireValue(backup.kind === 'v4_backup_restore_receipt' && backup.status === 'verified' && backup.source === 'dev_vue'
    && /^dev_vue_m1_source_\d{8}_\d{2}$/.test(backup.target) && backup.parity?.matched === true
    && backup.sqlScopeReviewed === true && backup.decryptionIntegrityVerified === true, 'inplace_backup_receipt_invalid')
  const fd = Number(process.env.V4_BACKUP_CREDENTIAL_FD)
  requireValue(Number.isInteger(fd) && fd >= 3, 'inplace_credential_fd_invalid')
  const credential = JSON.parse(await readFile(`/proc/self/fd/${fd}`, 'utf8'))
  const { default: mysql } = await import(pathToFileURL(process.env.V4_BACKUP_MYSQL2_MODULE).href)
  const connect = async () => {
    const c = await mysql.createConnection({ ...credential, database: backup.target, timezone: 'Z', dateStrings: true,
      supportBigNumbers: true, bigNumberStrings: true, jsonStrings: true, multipleStatements: false, connectTimeout: 10000 })
    try {
      const [[identity]] = await c.query('SELECT DATABASE() db,@@server_uuid uuid')
      requireValue(identity.db === backup.target && identity.uuid === backup.serverUuid, 'inplace_instance_mismatch')
      await c.query("SET SESSION time_zone='+00:00'")
      await c.query('SET SESSION autocommit=1')
      await c.query('SET SESSION lock_wait_timeout=10')
      return c
    } catch (error) { c.destroy(); throw error }
  }
  connection = await connect()
  const schema = await readSchemaFingerprint(connection)
  requireValue(schema.sha256 === backup.schemaSha256, 'inplace_restore_schema_changed')
  requireValue(!await verifyInplaceJournal(connection), 'inplace_rehearsal_already_started')
  const tables = []
  for (const table of schema.tables) {
    const [columns] = await connection.execute('SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [table.name])
    const [primary] = await connection.execute("SELECT COLUMN_NAME name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX", [table.name])
    requireValue(primary.length > 0, 'inplace_original_primary_missing')
    tables.push({ name: table.name, columns: columns.map(row => row.name), primary: primary.map(row => row.name) })
  }
  const before = await originalRows(connection, tables)
  console.log(JSON.stringify({ stage: 'original-data-hashed', tables: before.length }))
  const sql = splitSqlStatements(await readFile(new URL('../server/db/migrations/inplace/002_user_bridge_columns.sql', import.meta.url), 'utf8'))
  requireValue(JSON.stringify(sql) === JSON.stringify(inplaceColumnSteps.map(step => step.sql)), 'inplace_plan_sql_mismatch')
  const journalSql = splitSqlStatements(await readFile(new URL('../server/db/migrations/inplace/001_upgrade_journal.sql', import.meta.url), 'utf8'))
  requireValue(journalSql.length === 1, 'inplace_journal_sql_invalid')
  let executed = 0
  await withInplaceUpgradeLock(connection, backup.target, async () => {
    await executeColumnSteps(mysqlColumnStore(connection, false))
    await connection.query(journalSql[0])
    requireValue(await verifyInplaceJournal(connection), 'inplace_journal_missing')
    const store = mysqlColumnStore(connection, true)
    store.execute = async statement => {
      await connection.query(statement)
      executed++
      // Close the connection after committed DDL, before the journal can be completed.
      connection.destroy()
      throw new Error('inplace_injected_response_loss')
    }
    try { await executeColumnSteps(store, inplaceColumnSteps, { apply: true }) }
    catch (error) { if (error.message === 'inplace_injected_response_loss') throw error; throw new Error('inplace_unexpected_fault') }
  }).catch(error => { if (error.message !== 'inplace_injected_response_loss') throw error })
  requireValue(executed === 1, 'inplace_fault_not_exercised')
  connection = await connect()
  const recovery = await withInplaceUpgradeLock(connection, backup.target, async () => {
    requireValue(await verifyInplaceJournal(connection), 'inplace_journal_missing')
    const store = mysqlColumnStore(connection, true)
    const execute = store.execute
    store.execute = async statement => { await execute(statement); executed++ }
    const recovered = await executeColumnSteps(store, inplaceColumnSteps, { apply: true })
    requireValue(recovered.steps[0].status === 'reconciled', 'inplace_recovery_not_reconciled')
    const repeated = await executeColumnSteps(store, inplaceColumnSteps, { apply: true })
    requireValue(repeated.steps.every(step => step.status === 'completed') && executed === 9, 'inplace_replay_not_idempotent')
    return recovered
  })
  const after = await originalRows(connection, tables)
  requireValue(JSON.stringify(before) === JSON.stringify(after), 'inplace_original_data_changed')
  const report = { version: 1, kind: 'dev_vue_column_rehearsal', status: 'verified', target: backup.target, serverUuid: backup.serverUuid,
    backupSnapshotId: backup.sourceSnapshotId, completedAtUtc: new Date().toISOString(), originalColumns: tables,
    parity: after, recovery, ddlExecutions: executed, repeatNoop: true, sourceModified: false,
    scope: 'nine_additive_columns_only', fullNormalizationComplete: false }
  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ status: report.status, target: report.target, originalTables: tables.length, ddlExecutions: executed, repeatNoop: true }))
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', code: /^inplace_[a-z_]+$/.test(error.message) ? error.message : 'inplace_rehearsal_failed' }))
  process.exitCode = 1
} finally { if (connection) connection.destroy() }
