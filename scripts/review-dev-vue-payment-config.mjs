import { inspectPaymentConfigSources, paymentConfigSourceFields } from './lib/v4-payment-config-source.mjs'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { loadWalletAddressCoordinator } from './lib/inplace-wallet-address-schema.mjs'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { verifyInplaceJournal } from './lib/mysql-inplace-column-store.mjs'
import { verifyOriginalSchemaWithReferralRules } from './lib/inplace-referral-rule-schema.mjs'

const root = new URL('../', import.meta.url)
const reportPath = new URL('docs/migration/dev-vue-payment-config-source-review-20260907.json', root)
const check = (ok, code) => { if (!ok) throw new Error(code) }
let connection
try {
  const [mode] = process.argv.slice(2)
  check(process.argv.length === 3 && ['--write', '--verify'].includes(mode), 'payment_config_arguments')
  const previous = mode === '--verify' ? JSON.parse(await readFile(reportPath, 'utf8')) : null
  const backup = JSON.parse(await readFile(new URL('docs/migration/dev-vue-inplace-backup-20260906.json', root), 'utf8'))
  const plan = await loadWalletAddressCoordinator(root)
  const env = parse(await readFile(new URL('server/.env', root)))
  check(env.MYSQL_DATABASE === 'dev_vue', 'payment_config_database')
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: 'dev_vue', dateStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true })
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === 'dev_vue' && identity.uuid === backup.serverUuid, 'payment_config_identity')
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  check(await verifyInplaceJournal(connection), 'payment_config_journal')
  check((await coordinateInplaceSchema(plan.store(connection), plan)).structureComplete, 'payment_config_schema')
  await verifyOriginalSchemaWithReferralRules(connection, backup.schemaSha256, [...new Set(plan.steps.filter(s => !s.column).map(s => s.table))], plan.referralRuleReference)
  const [rows] = await connection.query("SELECT CAST(id AS CHAR) id,category,`key`,value,label,CAST(sort_order AS CHAR) sort_order,created_at,updated_at FROM system_config WHERE category='crypto_wallet' AND `key` IN ('payment_mode','fixed_tron_address','fixed_erc20_address','fixed_bep20_address','fixed_sol_address') ORDER BY system_config.id")
  const result = inspectPaymentConfigSources(rows.map(row => ({ ...row })))
  const [columns] = await connection.execute('SELECT COLUMN_NAME name,COLUMN_TYPE type,IS_NULLABLE nullable,COLUMN_DEFAULT defaultValue,COLLATION_NAME collationName FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', ['system_config'])
  check(columns.length === 8 && columns.every(column => Object.hasOwn(paymentConfigSourceFields, column.name)), 'payment_config_column_coverage')
  const [indexes] = await connection.execute('SELECT INDEX_NAME name,NON_UNIQUE nonUnique,SEQ_IN_INDEX position,COLUMN_NAME columnName FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX', ['system_config'])
  const referenceFiles = []
  for (const path of ['server/crypto/fixed-address.js', 'server/routes/payment.js']) {
    const bytes = await readFile(new URL(path, 'file:///D:/dev_codex/wall-street-skill-local/'))
    referenceFiles.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  const report = { kind: 'payment-config-source-review/v1', identity, schemaSteps: plan.steps.length,
    columns, indexes, result: { ...result, entries: result.entries.map(({ source, ...entry }) => ({ ...entry, key: source.key, valueSha256: source.value === null ? null : createHash('sha256').update(source.value).digest('hex'), createdAtRaw: source.created_at, updatedAtRaw: source.updated_at })) }, referenceFiles, sourceDatabaseWritten: false, businessConsumersSwitched: false }
  await connection.rollback()
  if (mode === '--write') await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  else check(JSON.stringify(previous) === JSON.stringify(report), 'payment_config_review_changed')
  console.log(JSON.stringify({ status: 'verified', rows: result.entries.length, blockers: result.blockers, databaseWrites: 0 }))
} catch (error) {
  console.error(JSON.stringify({ code: /^payment_config_[a-z_]+$/.test(error.message) ? error.message : 'payment_config_review_failed' }))
  process.exitCode = 1
} finally {
  if (connection) { await connection.rollback().catch(() => {}); await connection.end().catch(() => {}) }
}
