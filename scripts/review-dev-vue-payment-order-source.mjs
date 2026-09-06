import { inspectPaymentOrderSources, paymentOrderFields } from './lib/v4-payment-order-source.mjs'
import { inspectOrderCreditConversion } from './lib/v4-order-credit-conversion.mjs'
import { readFile, writeFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { hash } from './lib/v4-backfill-contract.mjs'
import { verifyOriginalSchemaWithUserDefaults } from './lib/inplace-user-defaults.mjs'
import { loadReferralLedgerCoordinator } from './lib/inplace-referral-ledger-schema.mjs'
import { representIdentityValue } from './lib/v4-identity-values.mjs'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { verifyInplaceJournal } from './lib/mysql-inplace-column-store.mjs'
import { validateColumnEvidence, readOriginalRows } from './lib/inplace-column-evidence.mjs'

const root = new URL('../', import.meta.url)
const path = 'docs/migration/dev-vue-payment-order-source-review-20260907.json'
const json = async name => JSON.parse(await readFile(new URL(name, root), 'utf8'))
const check = (ok, code) => { if (!ok) throw new Error(code) }
let connection
try {
  const [mode] = process.argv.slice(2)
  check(process.argv.length === 3 && ['--write', '--verify'].includes(mode), 'referral_review_arguments')
  const previous = mode === '--verify' ? await json(path) : null
  const backup = await json('docs/migration/dev-vue-inplace-backup-20260906.json')
  const columns = await json('docs/migration/dev-vue-inplace-column-rehearsal-20260906.json')
  validateColumnEvidence(backup, columns)
  const plan = await loadReferralLedgerCoordinator(root)
  const env = parse(await readFile(new URL('server/.env', root)))
  check(env.MYSQL_DATABASE === 'dev_vue', 'referral_review_database')
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: 'dev_vue', dateStrings: true, jsonStrings: true, timezone: 'Z',
    supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false })
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === 'dev_vue' && identity.uuid === backup.serverUuid, 'referral_review_identity')
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  check(await verifyInplaceJournal(connection), 'referral_review_journal')
  check((await coordinateInplaceSchema(plan.store(connection), plan)).structureComplete, 'referral_review_schema')
  await verifyOriginalSchemaWithUserDefaults(connection, backup.schemaSha256, [...new Set(plan.steps.filter(s => !s.column).map(s => s.table))])
  check(JSON.stringify(await readOriginalRows(connection, columns.originalColumns)) === JSON.stringify(columns.parity), 'referral_review_original_changed')
  const tables = []
  for (const table of ['orders', 'referrals', 'referral_rules']) {
    const [[ddl]] = await connection.query(`SHOW CREATE TABLE \`${table}\``)
    const [[count]] = await connection.query(`SELECT COUNT(*) n FROM \`${table}\``)
    const [fields] = await connection.execute('SELECT COLUMN_NAME name,COLUMN_TYPE type,IS_NULLABLE nullable,COLUMN_DEFAULT defaultValue,COLLATION_NAME collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [table])
    tables.push({ table, rows: String(count.n), ddl: ddl['Create Table'], fields })
  }
  const [orders] = await connection.query('SELECT CAST(o.id AS CHAR) id,CAST(o.user_id AS CHAR) user_id,o.order_id,o.status,o.currency,o.amount,o.amount_confirmed,o.referral_credit_applied,CASE WHEN u.id IS NULL THEN 1 ELSE 0 END orphan_user FROM orders o LEFT JOIN users u ON u.id=o.user_id ORDER BY o.id')
  const [userRows] = await connection.query('SELECT CAST(id AS CHAR) id FROM users ORDER BY users.id')
  const projection = Object.entries(paymentOrderFields).map(([field, [type]]) => type === 'int' ? `CAST(o.\`${field}\` AS CHAR) AS \`${field}\`` : `o.\`${field}\``).join(',')
  const [fullRows] = await connection.query(`SELECT ${projection} FROM orders o ORDER BY o.id`)
  const fullInspection = inspectPaymentOrderSources(fullRows.map(row => ({ ...row })), new Set(userRows.map(row => row.id)))
  const creditInspection = inspectOrderCreditConversion(orders.map(({ orphan_user, ...row }) => ({ ...row })), new Set(userRows.map(row => row.id)))
  const groups = new Map(), exceptions = [], obligations = []
  for (const row of orders) {
    const locator = hash({ table: 'orders', id: row.id })
    try {
      const amounts = ['amount', 'amount_confirmed', 'referral_credit_applied'].map(field => BigInt(representIdentityValue(row[field], 'decimal(20,8)', false).replace('.', '')))
      const [amount, cash, credit] = amounts
      const key = JSON.stringify([row.status, row.currency])
      const group = groups.get(key) ?? { status: row.status, currency: row.currency, rows: 0, amountUnits: 0n, cashUnits: 0n, creditUnits: 0n, creditedOrders: 0 }
      group.rows++; group.amountUnits += amount; group.cashUnits += cash; group.creditUnits += credit
      if (credit !== 0n) group.creditedOrders++
      groups.set(key, group)
      if (amount < 0n || cash < 0n || credit < 0n) exceptions.push({ locator, code: 'negative_order_money' })
      if (credit > amount) exceptions.push({ locator, code: 'credit_exceeds_order' })
      if (Number(row.orphan_user)) exceptions.push({ locator, code: 'orphan_user' })
      if (credit > 0n && row.status === 'pending') obligations.push({ locator, currency: row.currency, creditUnits: credit.toString(), sourceHash: hash({ ...row }) })
      if (credit > 0n && !['pending', 'paid', 'cancelled', 'expired'].includes(row.status)) exceptions.push({ locator, code: 'unknown_credit_order_status' })
    } catch { exceptions.push({ locator, code: 'invalid_money' }) }
  }
  const [rules] = await connection.query('SELECT CAST(id AS CHAR) id,plan,period,CAST(rate_bps AS CHAR) rate_bps,CAST(enabled AS CHAR) enabled FROM referral_rules ORDER BY id')
  const invalidRules = rules.filter(row => !/^\d+$/.test(row.rate_bps) || BigInt(row.rate_bps) > 10000n || !['0', '1'].includes(row.enabled)).map(row => hash({ table: 'referral_rules', id: row.id }))
  await connection.rollback()
  const report = { kind: 'payment-order-source-review/v1', fullOrderInspection: { version: fullInspection.version, fields: fullInspection.sourceFields, rows: fullInspection.entries.length, sourceHash: fullInspection.sourceHash, blockerCounts: Object.fromEntries([...new Set(fullInspection.blockers.map(b => b.code))].map(code => [code, fullInspection.blockers.filter(b => b.code === code).length])), fullOrderConverted: false, businessWritesEnabled: false }, creditInspection: { version: creditInspection.version, sourceHash: creditInspection.sourceHash, convertedProjectionHash: hash(creditInspection.entries), dispositions: Object.fromEntries([...new Set(creditInspection.entries.map(e => e.credit.disposition))].map(d => [d, creditInspection.entries.filter(e => e.credit.disposition === d).length])), blockers: creditInspection.blockers.map(b => ({ locator: hash(b.sourceId), code: b.code })), fullOrderConverted: false, businessWritesEnabled: false }, identity, schemaSteps: plan.steps.length,
    originalTablesVerified: columns.parity.length, originalRowsVerified: backup.parity.rows, tables,
    ordersRead: orders.length, orderProjectionHash: hash(orders.map(row => ({ ...row }))), amountScale: 8,
    groups: [...groups.values()].map(group => ({ ...group, amountUnits: group.amountUnits.toString(), cashUnits: group.cashUnits.toString(), creditUnits: group.creditUnits.toString() })),
    pendingCreditObligations: obligations, exceptions, rules: rules.map(row => ({ ...row })), invalidRules,
    coverage: 'order_money_identity_status_projection_and_rule_rows', historicalCurrencyBasisProven: false,
    databaseWrites: 0, fullNormalizationComplete: false }
  if (mode === '--write') await writeFile(new URL(path, root), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  else check(JSON.stringify(previous) === JSON.stringify(report), 'referral_review_changed')
  console.log(JSON.stringify({ status: 'verified', orders: orders.length, pendingCreditObligations: obligations.length, exceptions: exceptions.length, rules: rules.length, invalidRules: invalidRules.length, databaseWrites: 0 }))
} catch (error) {
  console.error(JSON.stringify({ code: /^referral_[a-z_]+$/.test(error.message) ? error.message : 'referral_review_failed' }))
  process.exitCode = 1
} finally {
  if (connection) { await connection.rollback().catch(() => {}); await connection.end().catch(() => {}) }
}
