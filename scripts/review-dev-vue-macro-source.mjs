import { readFile, writeFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { loadMacroSchemaCoordinator, macroTableNames } from './lib/inplace-macro-schema.mjs'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { verifyInplaceJournal } from './lib/mysql-inplace-column-store.mjs'
import { validateColumnEvidence, verifyOriginalSchema, readOriginalRows } from './lib/inplace-column-evidence.mjs'

const root = new URL('../', import.meta.url)
const json = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'))
const check = (ok, code) => { if (!ok) throw new Error(code) }
let connection
try {
  const [mode] = process.argv.slice(2)
  check(process.argv.length === 3 && ['--write', '--verify'].includes(mode), 'inplace_macro_source_arguments')
  const source = await json('docs/migration/dev-vue-inplace-source-20260906.json')
  const backup = await json('docs/migration/dev-vue-inplace-backup-20260906.json')
  const columns = await json('docs/migration/dev-vue-inplace-column-rehearsal-20260906.json')
  validateColumnEvidence(backup, columns)
  const plan = await loadMacroSchemaCoordinator(root)
  const env = parse(await readFile(new URL('server/.env', root)))
  check(env.MYSQL_DATABASE === 'dev_vue', 'inplace_macro_source_database')
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: 'dev_vue', dateStrings: true, jsonStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true })
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === 'dev_vue' && identity.uuid === backup.serverUuid, 'inplace_macro_source_identity')
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  check(await verifyInplaceJournal(connection), 'inplace_macro_source_journal')
  check((await coordinateInplaceSchema(plan.store(connection), plan)).structureComplete, 'inplace_macro_source_schema_incomplete')
  await verifyOriginalSchema(connection, backup.schemaSha256, [...new Set(plan.steps.filter(s => !s.column).map(s => s.table))])
  check(JSON.stringify(await readOriginalRows(connection, columns.originalColumns)) === JSON.stringify(columns.parity), 'inplace_macro_source_original_changed')
  const [keys] = await connection.query('SELECT category,`key` FROM system_config ORDER BY id')
  const candidates = keys.filter(row => /macro|economic|calendar|fred|宏观|财经|经济日历/i.test(`${row.category} ${row.key}`))
  const targets = []
  for (const table of macroTableNames) {
    const [[count]] = await connection.query(`SELECT COUNT(*) n FROM \`${table}\``)
    const [fields] = await connection.execute('SELECT COLUMN_NAME name,COLUMN_TYPE type,IS_NULLABLE nullable,COLUMN_DEFAULT defaultValue FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [table])
    targets.push({ table, rows: String(count.n), fields,
      dedicatedLegacyTablePresent: source.tables.some(row => row.table_name === table),
      historicalRowsMigrated: false, initializerExecuted: false })
  }
  await connection.rollback()
  const report = { kind: 'macro-source-disposition-review/v1', identity, originalSchemaHash: backup.schemaSha256,
    originalTablesVerified: columns.parity.length, originalRowsVerified: backup.parity.rows, targets,
    configKeysScanned: keys.length, configKeysetHash: sha256(JSON.stringify(keys)),
    matchingConfigKeys: candidates.map(row => ({ locatorHash: sha256(JSON.stringify(row)) })),
    coverage: 'dedicated_table_names_and_system_config_keys_only',
    remainingChecks: ['embedded_snapshot_content_mapping', 'new_domain_initialization_contract', 'macro_runtime_creation_and_ingestion'],
    databaseWrites: 0, fullNormalizationComplete: false }
  const target = new URL('docs/migration/dev-vue-macro-source-review-20260907.json', root)
  if (mode === '--write') await writeFile(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  else check(JSON.stringify(await json('docs/migration/dev-vue-macro-source-review-20260907.json')) === JSON.stringify(report), 'inplace_macro_source_review_changed')
  console.log(JSON.stringify({ status: 'verified', targets: targets.length, fields: targets.reduce((n,t) => n+t.fields.length, 0), configKeysScanned: keys.length, matchingConfigKeys: candidates.length, databaseWrites: 0 }))
} catch (error) {
  console.error(JSON.stringify({ code: /^inplace_[a-z_]+$/.test(error.message) ? error.message : 'inplace_macro_source_review_failed' })); process.exitCode = 1
} finally { if (connection) { await connection.rollback().catch(() => {}); await connection.end().catch(() => {}) } }
