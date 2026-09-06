import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { loadMigrationPlan } from './lib/v4-migration-plan.mjs'
import { plannedColumns } from './lib/v4-upgrade-review.mjs'
import { reviewInplaceSchema } from './lib/dev-vue-inplace-review.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
if (args.length !== 1 || !['--live', '--verify'].includes(args[0])) throw new Error('use_exactly_one_of_live_or_verify')
const sourcePath = resolve(root, 'docs/migration/dev-vue-inplace-source-20260906.json')
const reportPath = resolve(root, 'docs/migration/dev-vue-inplace-review-20260906.json')
const target = plannedColumns(await loadMigrationPlan({ rootDirectory: root }))
let connection
try {
  if (args[0] === '--live') {
    const env = parse(await readFile(resolve(root, 'server/.env')))
    if (env.MYSQL_DATABASE !== 'dev_vue') throw new Error('inplace_database_must_be_dev_vue')
    connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
      password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, connectTimeout: 5000, supportBigNumbers: true, bigNumberStrings: true })
    await connection.query('START TRANSACTION READ ONLY')
    const [[identity]] = await connection.query('SELECT DATABASE() database_name, VERSION() mysql_version, @@session.sql_mode sql_mode, @@session.time_zone session_timezone')
    if (identity.database_name !== 'dev_vue') throw new Error('inplace_connected_database_mismatch')
    const collect = async () => {
      const [tables] = await connection.query('SELECT TABLE_NAME table_name,TABLE_TYPE table_type,ENGINE engine,TABLE_COLLATION collation FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME')
      const [columns] = await connection.query('SELECT TABLE_NAME table_name,COLUMN_NAME column_name,ORDINAL_POSITION ordinal_position,COLUMN_TYPE column_type,IS_NULLABLE is_nullable,COLUMN_DEFAULT column_default,CHARACTER_SET_NAME charset,COLLATION_NAME collation,EXTRA extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION')
      const [indexes] = await connection.query('SELECT TABLE_NAME table_name,INDEX_NAME index_name,NON_UNIQUE non_unique,SEQ_IN_INDEX seq_in_index,COLUMN_NAME column_name,SUB_PART sub_part,INDEX_TYPE index_type FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX')
      const [relations] = await connection.query('SELECT TABLE_NAME table_name,CONSTRAINT_NAME constraint_name,COLUMN_NAME column_name,REFERENCED_TABLE_NAME referenced_table_name,REFERENCED_COLUMN_NAME referenced_column_name FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION')
      return { tables, columns, indexes, relations }
    }
    const first = await collect()
    const second = await collect()
    if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error('inplace_metadata_changed_during_read')
    let legacyMigrationIds = []
    if (first.columns.some(column => column.table_name === 'schema_migrations' && column.column_name === 'id')) {
      const [records] = await connection.query('SELECT id FROM schema_migrations ORDER BY id')
      legacyMigrationIds = records.map(row => String(row.id))
    }
    await connection.rollback()
    const source = { database: 'dev_vue', observedAt: new Date().toISOString(), identity,
      scope: 'Read-only metadata, two consecutive equal reads; not a frozen backup or complete object inventory. No business row payloads; migration IDs only.', ...first, legacyMigrationIds }
    const report = reviewInplaceSchema(source, target)
    await writeFile(sourcePath, JSON.stringify(source, null, 2) + '\n')
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report.summary))
  } else {
    const source = JSON.parse(await readFile(sourcePath, 'utf8'))
    const saved = JSON.parse(await readFile(reportPath, 'utf8'))
    const expected = reviewInplaceSchema(source, target)
    if (JSON.stringify(saved) !== JSON.stringify(expected)) throw new Error('inplace_report_drift')
    console.log(JSON.stringify({ verified: true, ...expected.summary }))
  }
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', code: error.code ?? (String(error.message).startsWith('inplace_') ? error.message : 'inplace_review_failed') }))
  process.exitCode = 1
} finally { if (connection) await connection.end().catch(() => {}) }
