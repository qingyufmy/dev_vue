import { inspectReferralRuleSources, referralRuleSourceFields } from './lib/v4-referral-rule-source.mjs'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { loadMembershipCoordinator } from './lib/inplace-membership-schema.mjs'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { verifyInplaceJournal } from './lib/mysql-inplace-column-store.mjs'
import { verifyOriginalSchemaWithUserDefaults } from './lib/inplace-user-defaults.mjs'

const root = new URL('../', import.meta.url)
const reportPath = new URL('docs/migration/dev-vue-referral-rule-source-review-20260907.json', root)
const check = (ok, code) => { if (!ok) throw new Error(code) }
let connection
try {
  const [mode] = process.argv.slice(2)
  check(process.argv.length === 3 && ['--write', '--verify'].includes(mode), 'referral_rule_arguments')
  const previous = mode === '--verify' ? JSON.parse(await readFile(reportPath, 'utf8')) : null
  const backup = JSON.parse(await readFile(new URL('docs/migration/dev-vue-inplace-backup-20260906.json', root), 'utf8'))
  const plan = await loadMembershipCoordinator(root)
  const env = parse(await readFile(new URL('server/.env', root)))
  check(env.MYSQL_DATABASE === 'dev_vue', 'referral_rule_database')
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: 'dev_vue', dateStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true })
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === 'dev_vue' && identity.uuid === backup.serverUuid, 'referral_rule_identity')
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  check(await verifyInplaceJournal(connection), 'referral_rule_journal')
  check((await coordinateInplaceSchema(plan.store(connection), plan)).structureComplete, 'referral_rule_schema')
  await verifyOriginalSchemaWithUserDefaults(connection, backup.schemaSha256, [...new Set(plan.steps.filter(s => !s.column).map(s => s.table))])
  const [rows] = await connection.query('SELECT CAST(id AS CHAR) id,plan,period,CAST(rate_bps AS CHAR) rate_bps,CAST(enabled AS CHAR) enabled FROM referral_rules ORDER BY referral_rules.id')
  const result = inspectReferralRuleSources(rows.map(row => ({ ...row })))
  const [columns] = await connection.execute('SELECT COLUMN_NAME name,COLUMN_TYPE type,IS_NULLABLE nullable,COLUMN_DEFAULT defaultValue,COLLATION_NAME collationName FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', ['referral_rules'])
  check(columns.length === 5 && columns.every(column => Object.hasOwn(referralRuleSourceFields, column.name)), 'referral_rule_column_coverage')
  const [indexes] = await connection.execute('SELECT INDEX_NAME name,NON_UNIQUE nonUnique,SEQ_IN_INDEX position,COLUMN_NAME columnName FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX', ['referral_rules'])
  const referenceFiles = []
  for (const path of ['server/db.js', 'server/utils.js', 'server/routes/admin.js']) {
    const bytes = await readFile(new URL(path, 'file:///D:/dev_codex/wall-street-skill-local/'))
    referenceFiles.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  const report = { kind: 'referral-rule-source-review/v1', identity, schemaSteps: plan.steps.length,
    columns, indexes, result, referenceFiles, sourceDatabaseWritten: false, businessConsumersSwitched: false }
  await connection.rollback()
  if (mode === '--write') await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  else check(JSON.stringify(previous) === JSON.stringify(report), 'referral_rule_review_changed')
  console.log(JSON.stringify({ status: 'verified', rows: result.entries.length, blockers: result.blockers, missingScopes: result.missingScopes, databaseWrites: 0 }))
} catch (error) {
  console.error(JSON.stringify({ code: /^referral_rule_[a-z_]+$/.test(error.message) ? error.message : 'referral_rule_review_failed' }))
  process.exitCode = 1
} finally {
  if (connection) { await connection.rollback().catch(() => {}); await connection.end().catch(() => {}) }
}
