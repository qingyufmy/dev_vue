import { readFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { splitSqlStatements } from './lib/v4-migration-plan.mjs'
import { executeColumnSteps, inplaceColumnSteps } from './lib/dev-vue-column-upgrade.mjs'
import { mysqlColumnStore, verifyInplaceJournal, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { loadColumnEvidence, verifyOriginalSchema, readOriginalRows } from './lib/inplace-column-evidence.mjs'

const root = new URL('..', import.meta.url)
let connection
try {
  const args = process.argv.slice(2)
  const apply = args[0] === '--apply'
  if (!(args.length === 1 && args[0] === '--plan') && !(apply && args.length === 4)) throw new Error('inplace_arguments_use_plan_or_apply_with_three_evidence_paths')
  const evidence = apply ? await loadColumnEvidence(root, args.slice(1)) : null
  const sql = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/002_user_bridge_columns.sql', root), 'utf8'))
  if (JSON.stringify(sql) !== JSON.stringify(inplaceColumnSteps.map(step => step.sql))) throw new Error('inplace_plan_sql_mismatch')
  const env = parse(await readFile(new URL('server/.env', root)))
  if (env.MYSQL_DATABASE !== 'dev_vue') throw new Error('inplace_database_mismatch')
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, timezone: 'Z', dateStrings: true, jsonStrings: true,
    connectTimeout: 5000, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false })
  await connection.query("SET SESSION time_zone = '+00:00'")
  await connection.query('SET SESSION autocommit=1')
  await connection.query('SET SESSION lock_wait_timeout=10')
  const report = await withInplaceUpgradeLock(connection, 'dev_vue', async () => {
    const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
    if (identity.db !== 'dev_vue' || (apply && identity.uuid !== evidence.backup.serverUuid)) throw new Error('inplace_database_mismatch')
    let hasJournal = await verifyInplaceJournal(connection)
    for (const table of ['users', 'bridge_refresh_sessions']) {
      const [rows] = await connection.execute('SELECT ENGINE engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [table])
      if (rows.length !== 1 || rows[0].engine !== 'InnoDB') throw new Error('inplace_required_table_missing')
    }
    const planned = await executeColumnSteps(mysqlColumnStore(connection, hasJournal))
    if (!apply) return { ...planned, database: 'dev_vue', needsJournal: !hasJournal }
    await verifyOriginalSchema(connection, evidence.backup.schemaSha256)
    const before = await readOriginalRows(connection, evidence.rehearsal.originalColumns)
    if (JSON.stringify(before) !== JSON.stringify(evidence.rehearsal.parity)) throw new Error('inplace_source_changed_since_backup')
    if (!hasJournal) {
      const journal = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/001_upgrade_journal.sql', root), 'utf8'))
      if (journal.length !== 1) throw new Error('inplace_journal_sql_invalid')
      await connection.query(journal[0])
      hasJournal = await verifyInplaceJournal(connection)
      if (!hasJournal) throw new Error('inplace_journal_missing')
    }
    const result = await executeColumnSteps(mysqlColumnStore(connection, hasJournal), inplaceColumnSteps, { apply: true })
    await verifyOriginalSchema(connection, evidence.backup.schemaSha256)
    const after = await readOriginalRows(connection, evidence.rehearsal.originalColumns)
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('inplace_original_data_changed')
    return { ...result, database: 'dev_vue', serverUuid: identity.uuid, originalTablesVerified: after.length,
      originalRowsVerified: after.reduce((total, table) => total + BigInt(table.rows), 0n).toString(),
      backupSnapshotId: evidence.backup.sourceSnapshotId, completedAtUtc: new Date().toISOString(),
      dataPreserved: true, fullNormalizationComplete: false }
  })
  console.log(JSON.stringify(report))
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? (String(error.message).startsWith('inplace_') ? error.message : 'inplace_plan_failed') }))
  process.exitCode = 1
} finally { if (connection) await connection.end().catch(() => {}) }
