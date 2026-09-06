import { readFile, writeFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { hash } from './lib/v4-backfill-contract.mjs'
import { paymentEffectFields } from './lib/v4-payment-effects-source.mjs'
import { loadPaymentMatchCoordinator } from './lib/inplace-payment-match-schema.mjs'
import { inspectMembershipSources, membershipSourceFields } from './lib/v4-membership-source.mjs'
import { paymentOrderFields } from './lib/v4-payment-order-source.mjs'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { verifyInplaceJournal } from './lib/mysql-inplace-column-store.mjs'
import { verifyOriginalSchemaWithUserDefaults } from './lib/inplace-user-defaults.mjs'

const root = new URL('../', import.meta.url)
const reportPath = new URL('docs/migration/dev-vue-membership-source-review-20260907.json', root)
const check = (ok, code) => { if (!ok) throw new Error(code) }
let connection
try {
  const [mode] = process.argv.slice(2)
  check(process.argv.length === 3 && ['--write', '--verify'].includes(mode), 'payment_effect_arguments')
  const previous = mode === '--verify' ? JSON.parse(await readFile(reportPath, 'utf8')) : null
  const backup = JSON.parse(await readFile(new URL('docs/migration/dev-vue-inplace-backup-20260906.json', root), 'utf8'))
  const plan = await loadPaymentMatchCoordinator(root)
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
  const read = async (table, fields) => {
    const projection = Object.entries(fields).map(([key, [type]]) => ['int', 'bigint'].includes(type) ? `CAST(\`${key}\` AS CHAR) AS \`${key}\`` : `\`${key}\``).join(',')
    const [rows] = await connection.query(`SELECT ${projection} FROM ${table} ORDER BY ${table}.id`)
    return rows.map(row => ({ ...row }))
  }
  const users = await read('users', membershipSourceFields), orders = await read('orders', paymentOrderFields), effects = await read('payment_side_effects', paymentEffectFields)
  const result = inspectMembershipSources(users, orders, effects)
  const report = { kind: result.version, identity, schemaSteps: plan.steps.length, sourceFields: result.sourceFields,
    rows: users.length, sourceHash: result.sourceHash, orderSourceHash: hash(orders), effectSourceHash: hash(effects),
    plans: [...new Set(users.map(row => row.plan))].sort().map(plan => ({ plan, rows: users.filter(row => row.plan === plan).length })),
    expiryNullRows: users.filter(row => row.plan_expires_at === null).length,
    usersWithPaidOrders: result.entries.filter(entry => entry.paidOrderSourceIds.length > 0).length,
    paidOrders: result.entries.reduce((total, entry) => total + entry.paidOrderSourceIds.length, 0),
    completedDeliveries: result.entries.reduce((total, entry) => total + entry.completedDeliverySourceIds.length, 0),
    blockers: result.blockers.map(b => ({ locator: hash(b.sourceId), code: b.code })),
    deliveryBlockers: result.deliveryBlockers.map(b => ({ locator: hash(b.sourceId), code: b.code })),
    membershipActivationsProven: 0, databaseWrites: 0, fullMembershipConverted: false }
  await connection.rollback()
  if (mode === '--write') await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  else check(JSON.stringify(previous) === JSON.stringify(report), 'payment_effect_review_changed')
  console.log(JSON.stringify({ status: 'verified', rows: users.length, plans: report.plans, blockers: [...new Set(result.blockers.map(b => b.code))], databaseWrites: 0 }))
} catch (error) {
  console.error(JSON.stringify({ code: /^payment_effect_[a-z_]+$/.test(error.message) ? error.message : 'payment_effect_review_failed' }))
  process.exitCode = 1
} finally {
  if (connection) { await connection.rollback().catch(() => {}); await connection.end().catch(() => {}) }
}
