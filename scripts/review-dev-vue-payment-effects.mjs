import { readFile, writeFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { hash } from './lib/v4-backfill-contract.mjs'
import { inspectPaymentEffects, paymentEffectFields } from './lib/v4-payment-effects-source.mjs'
import { loadReferralLedgerCoordinator } from './lib/inplace-referral-ledger-schema.mjs'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { verifyInplaceJournal } from './lib/mysql-inplace-column-store.mjs'
import { verifyOriginalSchemaWithUserDefaults } from './lib/inplace-user-defaults.mjs'

const root = new URL('../', import.meta.url)
const reportPath = new URL('docs/migration/dev-vue-payment-effects-review-20260907.json', root)
const check = (ok, code) => { if (!ok) throw new Error(code) }
let connection
try {
  const [mode] = process.argv.slice(2)
  check(process.argv.length === 3 && ['--write', '--verify'].includes(mode), 'payment_effect_arguments')
  const previous = mode === '--verify' ? JSON.parse(await readFile(reportPath, 'utf8')) : null
  const backup = JSON.parse(await readFile(new URL('docs/migration/dev-vue-inplace-backup-20260906.json', root), 'utf8'))
  const plan = await loadReferralLedgerCoordinator(root)
  const env = parse(await readFile(new URL('server/.env', root)))
  check(env.MYSQL_DATABASE === 'dev_vue', 'payment_effect_database')
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: 'dev_vue', dateStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true })
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === 'dev_vue' && identity.uuid === backup.serverUuid, 'payment_effect_identity')
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  check(await verifyInplaceJournal(connection), 'payment_effect_journal')
  check((await coordinateInplaceSchema(plan.store(connection), plan)).structureComplete, 'payment_effect_schema')
  await verifyOriginalSchemaWithUserDefaults(connection, backup.schemaSha256, [...new Set(plan.steps.filter(s => !s.column).map(s => s.table))])
  const projection = Object.entries(paymentEffectFields).map(([key, [type]]) => ['int', 'bigint'].includes(type) ? `CAST(\`${key}\` AS CHAR) AS \`${key}\`` : `\`${key}\``).join(',')
  const [rows] = await connection.query(`SELECT ${projection} FROM payment_side_effects ORDER BY payment_side_effects.id`)
  const [orders] = await connection.query('SELECT CAST(id AS CHAR) id,order_id,CAST(user_id AS CHAR) user_id,status FROM orders ORDER BY orders.id')
  const result = inspectPaymentEffects(rows.map(row => ({ ...row })), orders.map(row => ({ ...row })))
  const [links] = await connection.query('SELECT CAST(e.id AS CHAR) effect_id,CAST(o.id AS CHAR) order_id FROM payment_side_effects e LEFT JOIN orders o ON o.order_id=e.order_id ORDER BY e.id,o.id')
  check(links.length === result.entries.length && links.every((link, i) => link.effect_id === result.entries[i].sourceId && link.order_id === result.entries[i].orderSourceId), 'payment_effect_link_disagreement')
  const [[ddl]] = await connection.query('SHOW CREATE TABLE payment_side_effects')
  const report = { kind: result.version, identity, schemaSteps: plan.steps.length, sourceFields: Object.keys(paymentEffectFields).length,
    rows: rows.length, sourceHash: result.sourceHash, orderProjectionHash: hash(orders.map(row => ({ ...row }))), ddl: ddl['Create Table'],
    statuses: [...new Set(rows.map(row => row.status))].sort().map(status => ({ status, rows: rows.filter(row => row.status === status).length })),
    exactAndSqlLinksAgree: true, blockers: result.blockers.map(b => ({ locator: hash(b.sourceId), code: b.code })),
    membershipActivationsProven: 0, databaseWrites: 0, fullPaymentConverted: false }
  await connection.rollback()
  if (mode === '--write') await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  else check(JSON.stringify(previous) === JSON.stringify(report), 'payment_effect_review_changed')
  console.log(JSON.stringify({ status: 'verified', rows: rows.length, statuses: report.statuses, blockers: [...new Set(result.blockers.map(b => b.code))], databaseWrites: 0 }))
} catch (error) {
  console.error(JSON.stringify({ code: /^payment_effect_[a-z_]+$/.test(error.message) ? error.message : 'payment_effect_review_failed' }))
  process.exitCode = 1
} finally {
  if (connection) { await connection.rollback().catch(() => {}); await connection.end().catch(() => {}) }
}
