import { readFile, writeFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { hash } from './lib/v4-backfill-contract.mjs'
import { inspectPaymentWatches, paymentWatchFields } from './lib/v4-payment-watch-source.mjs'
import { inspectPaymentOrderSources, paymentOrderFields } from './lib/v4-payment-order-source.mjs'
import { loadReferralLedgerCoordinator } from './lib/inplace-referral-ledger-schema.mjs'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { verifyInplaceJournal } from './lib/mysql-inplace-column-store.mjs'
import { verifyOriginalSchemaWithUserDefaults } from './lib/inplace-user-defaults.mjs'

const root = new URL('../', import.meta.url)
const reportPath = new URL('docs/migration/dev-vue-payment-watch-review-20260907.json', root)
const json = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'))
const check = (ok, code) => { if (!ok) throw new Error(code) }
let connection
try {
  const [mode] = process.argv.slice(2)
  check(process.argv.length === 3 && ['--write', '--verify'].includes(mode), 'payment_watch_arguments')
  const previous = mode === '--verify' ? JSON.parse(await readFile(reportPath, 'utf8')) : null
  const backup = await json('docs/migration/dev-vue-inplace-backup-20260906.json')
  const plan = await loadReferralLedgerCoordinator(root)
  const env = parse(await readFile(new URL('server/.env', root)))
  check(env.MYSQL_DATABASE === 'dev_vue', 'payment_watch_database')
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: 'dev_vue', dateStrings: true, timezone: 'Z', supportBigNumbers: true,
    bigNumberStrings: true, multipleStatements: false })
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === 'dev_vue' && identity.uuid === backup.serverUuid, 'payment_watch_identity')
  await connection.query("SET SESSION time_zone='+00:00'")
  const [[session]] = await connection.query('SELECT @@session.time_zone offsetValue')
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  check(await verifyInplaceJournal(connection), 'payment_watch_journal')
  check((await coordinateInplaceSchema(plan.store(connection), plan)).structureComplete, 'payment_watch_schema')
  await verifyOriginalSchemaWithUserDefaults(connection, backup.schemaSha256, [...new Set(plan.steps.filter(s => !s.column).map(s => s.table))])
  const projection = fields => Object.entries(fields).map(([key, [type]]) => type === 'int' ? `CAST(\`${key}\` AS CHAR) AS \`${key}\`` : `\`${key}\``).join(',')
  const [orderRows] = await connection.query(`SELECT ${projection(paymentOrderFields)} FROM orders ORDER BY orders.id`)
  const [watchRows] = await connection.query(`SELECT ${projection(paymentWatchFields)} FROM crypto_watch_list ORDER BY crypto_watch_list.id`)
  const [users] = await connection.query('SELECT CAST(id AS CHAR) id FROM users ORDER BY users.id')
  const orders = orderRows.map(row => ({ ...row })), watches = watchRows.map(row => ({ ...row }))
  const orderInspection = inspectPaymentOrderSources(orders, new Set(users.map(row => row.id)))
  const result = inspectPaymentWatches(watches, orders, { sessionOffset: session.offsetValue })
  // Compare MySQL's legacy collation join with exact machine-identifier matching.
  const [sqlLinks] = await connection.query('SELECT CAST(w.id AS CHAR) watch_id,CAST(o.id AS CHAR) order_id FROM crypto_watch_list w LEFT JOIN orders o ON o.order_id=w.order_id ORDER BY w.id,o.id')
  check(sqlLinks.length === result.entries.length && sqlLinks.every((row, i) => row.watch_id === result.entries[i].sourceId && row.order_id === result.entries[i].orderSourceId), 'payment_watch_collation_link_disagreement')
  const [[ddl]] = await connection.query('SHOW CREATE TABLE crypto_watch_list')
  const [duplicates] = await connection.query('SELECT COUNT(*) n FROM crypto_watch_list WHERE tx_hash IS NOT NULL GROUP BY tx_hash HAVING COUNT(*)>1')
  const statuses = [...new Set(watches.map(row => row.status))].sort().map(status => ({ status, rows: watches.filter(row => row.status === status).length }))
  const missing = orders.filter(row => result.ordersWithoutWatch.includes(row.id)).map(row => ({ locator: hash(row.id), status: row.status,
    appliedCredit: row.referral_credit_applied, expectedAmount: row.crypto_amount, hasTransactionHash: row.crypto_tx_hash !== null }))
  const report = { kind: result.version, identity, schemaSteps: plan.steps.length, orderRows: orders.length, orderSourceHash: orderInspection.sourceHash,
    watchRows: watches.length, watchSourceHash: result.sourceHash, sourceFields: Object.keys(paymentWatchFields).length,
    ddl: ddl['Create Table'], statuses, exactAndSqlLinksAgree: true, duplicateHashGroupsBySql: duplicates.length,
    blockers: result.blockers.map(b => ({ locator: hash(b.sourceId), code: b.code })), ordersWithoutWatch: missing,
    orderBlockers: result.orderBlockers.map(b => ({ locator: hash(b.sourceId), code: b.code })),
    createdAtUtcRows: result.entries.filter(e => e.createdAtUtc !== null).length, sessionOffset: session.offsetValue,
    databaseWrites: 0, fullPaymentConverted: false }
  await connection.rollback()
  if (mode === '--write') await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  else check(JSON.stringify(previous) === JSON.stringify(report), 'payment_watch_review_changed')
  console.log(JSON.stringify({ status: 'verified', watchRows: watches.length, orders: orders.length, statuses,
    blockers: [...new Set(result.blockers.map(b => b.code))], ordersWithoutWatch: missing.length, databaseWrites: 0 }))
} catch (error) {
  console.error(JSON.stringify({ code: /^payment_watch_[a-z_]+$/.test(error.message) ? error.message : 'payment_watch_review_failed' }))
  process.exitCode = 1
} finally {
  if (connection) { await connection.rollback().catch(() => {}); await connection.end().catch(() => {}) }
}
