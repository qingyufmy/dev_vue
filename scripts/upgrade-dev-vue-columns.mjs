import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { splitSqlStatements } from './lib/v4-migration-plan.mjs'
import { executeColumnSteps, inplaceColumnSteps } from './lib/dev-vue-column-upgrade.mjs'
import { mysqlColumnStore, verifyInplaceJournal, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'

const root = new URL('..', import.meta.url)
const args = process.argv.slice(2)
// Apply is deliberately unavailable until backup/restore and real fault rehearsals are wired.
if (args.length !== 1 || args[0] !== '--plan') throw new Error('inplace_apply_not_ready_use_plan')
let connection
try {
  const sql = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/002_user_bridge_columns.sql', root), 'utf8'))
  if (JSON.stringify(sql) !== JSON.stringify(inplaceColumnSteps.map(step => step.sql))) throw new Error('inplace_plan_sql_mismatch')
  const env = parse(await readFile(new URL('server/.env', root)))
  if (env.MYSQL_DATABASE !== 'dev_vue') throw new Error('inplace_database_mismatch')
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, timezone: 'Z', connectTimeout: 5000, supportBigNumbers: true, bigNumberStrings: true })
  await connection.query("SET SESSION time_zone = '+00:00'")
  const report = await withInplaceUpgradeLock(connection, 'dev_vue', async () => {
    await connection.query('START TRANSACTION READ ONLY')
    const [[row]] = await connection.query('SELECT DATABASE() db')
    if (row.db !== 'dev_vue') throw new Error('inplace_database_mismatch')
    const hasJournal = await verifyInplaceJournal(connection)
    for (const table of ['users', 'bridge_refresh_sessions']) {
      const [rows] = await connection.execute('SELECT ENGINE engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [table])
      if (rows.length !== 1 || rows[0].engine !== 'InnoDB') throw new Error('inplace_required_table_missing')
    }
    const result = await executeColumnSteps(mysqlColumnStore(connection, hasJournal))
    await connection.rollback()
    return { ...result, database: 'dev_vue', needsJournal: !hasJournal, executable: false, sqlFile: fileURLToPath(new URL('server/db/migrations/inplace/002_user_bridge_columns.sql', root)) }
  })
  console.log(JSON.stringify(report))
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? (String(error.message).startsWith('inplace_') ? error.message : 'inplace_plan_failed') }))
  process.exitCode = 1
} finally { if (connection) await connection.end().catch(() => {}) }
