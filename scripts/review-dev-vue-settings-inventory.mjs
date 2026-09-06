import { hash } from './lib/v4-backfill-contract.mjs'
import { paymentConfigSourceFields } from './lib/v4-payment-config-source.mjs'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { loadWalletAddressCoordinator } from './lib/inplace-wallet-address-schema.mjs'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { verifyInplaceJournal } from './lib/mysql-inplace-column-store.mjs'
import { verifyOriginalSchemaWithReferralRules } from './lib/inplace-referral-rule-schema.mjs'

const root = new URL('../', import.meta.url)
const reportPath = new URL('docs/migration/dev-vue-settings-inventory-20260907.json', root)
const check = (ok, code) => { if (!ok) throw new Error(code) }
let connection
try {
  const [mode] = process.argv.slice(2)
  check(process.argv.length === 3 && ['--write', '--verify'].includes(mode), 'settings_inventory_arguments')
  const previous = mode === '--verify' ? JSON.parse(await readFile(reportPath, 'utf8')) : null
  const backup = JSON.parse(await readFile(new URL('docs/migration/dev-vue-inplace-backup-20260906.json', root), 'utf8'))
  const plan = await loadWalletAddressCoordinator(root)
  const env = parse(await readFile(new URL('server/.env', root)))
  check(env.MYSQL_DATABASE === 'dev_vue', 'settings_inventory_database')
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: 'dev_vue', dateStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true })
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === 'dev_vue' && identity.uuid === backup.serverUuid, 'settings_inventory_identity')
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  check(await verifyInplaceJournal(connection), 'settings_inventory_journal')
  check((await coordinateInplaceSchema(plan.store(connection), plan)).structureComplete, 'settings_inventory_schema')
  await verifyOriginalSchemaWithReferralRules(connection, backup.schemaSha256, [...new Set(plan.steps.filter(s => !s.column).map(s => s.table))], plan.referralRuleReference)
  // Values stay inside MySQL: only representation metadata and complete-row hashes leave the server.
  const [rows] = await connection.query(`SELECT CAST(id AS CHAR) id,category,\`key\`,
    CASE WHEN value IS NULL THEN 'null' WHEN OCTET_LENGTH(value)=0 THEN 'empty' ELSE 'text' END valueKind,
    CAST(OCTET_LENGTH(value) AS CHAR) valueBytes,JSON_VALID(value) jsonValid,
    CAST(sort_order AS CHAR) sortOrder,created_at createdAtRaw,updated_at updatedAtRaw,
    SHA2(CAST(JSON_ARRAY(id,category,\`key\`,value,label,sort_order,DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s.%f'),DATE_FORMAT(updated_at,'%Y-%m-%d %H:%i:%s.%f')) AS CHAR CHARACTER SET utf8mb4),256) rowSha256
    FROM system_config ORDER BY id`)
  const entries = rows.map(row => ({ ...row, sensitiveNameCandidate: /mnemonic|private_key|secret|password|access_key|api_key|rpc_url|(^|_)pass($|_)|(^|_)token($|_)/i.test(row.key) }))
  const categories = [...new Set(entries.map(row => row.category))].sort().map(category => ({ category, rows: entries.filter(row => row.category === category).length }))
  const result = { version: 'settings-metadata-inventory/v1', entries, categories, sourceHash: hash(entries),
    sourceValuesReadByClient: false, valuesDecrypted: false, typesApproved: false, deletionAuthorized: false }
  const [columns] = await connection.execute('SELECT COLUMN_NAME name,COLUMN_TYPE type,IS_NULLABLE nullable,COLUMN_DEFAULT defaultValue,COLLATION_NAME collationName FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', ['system_config'])
  check(columns.length === 8 && columns.every(column => Object.hasOwn(paymentConfigSourceFields, column.name)), 'settings_inventory_column_coverage')
  const [indexes] = await connection.execute('SELECT INDEX_NAME name,NON_UNIQUE nonUnique,SEQ_IN_INDEX position,COLUMN_NAME columnName FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX', ['system_config'])
  const referenceFiles = []
  for (const path of ['server/system-config-secrets.js', 'server/routes/config.js', 'server/storage/storage-config.js', 'server/sms.js', 'server/system-email.js']) {
    const bytes = await readFile(new URL(path, 'file:///D:/dev_codex/wall-street-skill-local/'))
    referenceFiles.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  const report = { kind: 'settings-inventory/v1', identity, schemaSteps: plan.steps.length,
    columns, indexes, result, referenceFiles, sourceDatabaseWritten: false, businessConsumersSwitched: false }
  await connection.rollback()
  if (mode === '--write') await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  else check(JSON.stringify(previous) === JSON.stringify(report), 'settings_inventory_review_changed')
  console.log(JSON.stringify({ status: 'verified', rows: result.entries.length, categories: categories.length, databaseWrites: 0 }))
} catch (error) {
  console.error(JSON.stringify({ code: /^settings_inventory_[a-z_]+$/.test(error.message) ? error.message : 'settings_inventory_review_failed' }))
  process.exitCode = 1
} finally {
  if (connection) { await connection.rollback().catch(() => {}); await connection.end().catch(() => {}) }
}
