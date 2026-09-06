import { readFile, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
const base = new URL('./', import.meta.url)
const sha = value => createHash('sha256').update(value).digest('hex')
const check = (ok, code) => { if (!ok) throw new Error(code) }
const userId = '-2147482900', runId = 'ffffffff-ffff-4fff-8fff-fffffffffff2'
let connection
try {
  check(process.platform === 'linux' && process.getuid() === 0, 'payment_order_probe_scope')
  const sql = await readFile(new URL('012_payment_orders.sql', base), 'utf8')
  const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
  const credentials = JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`, 'utf8'))
  connection = await mysql.createConnection({ ...credentials, database: 'dev_vue_m1_a', dateStrings: true, timezone: 'Z', multipleStatements: false })
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
  check(identity.db === 'dev_vue_m1_a' && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'payment_order_probe_identity')
  await connection.query("SET SESSION time_zone='+00:00'")
  const [[exists]] = await connection.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='payment_orders'")
  check(Number(exists.n) === 0, 'payment_order_probe_already_created')
  await connection.query(sql)
  const [[definition]] = await connection.query('SHOW CREATE TABLE payment_orders')
  await connection.beginTransaction()
  await connection.execute("INSERT INTO users (id,password,created_at,updated_at) VALUES (?,'disabled-schema-fixture',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [userId])
  await connection.execute("INSERT INTO data_migration_runs (id,bindings_sha256,bindings_json,created_at_utc) VALUES (?,?,'{}',UTC_TIMESTAMP(3))", [runId, 'a'.repeat(64)])
  const native = { id: '1', user_id: userId, order_number: 'native', external_order_id: null, product_code: 'plus', product_label: '',
    billing_period_code: 'month', billing_period_label: null, order_amount: '0', legacy_amount_confirmed: null, referral_credit_applied: '0',
    currency_code: 'USD', status: 'pending', status_label: '', payment_method_code: null, created_at_utc: '2026-09-07 00:00:00.123',
    paid_at_utc: null, revision: '1', origin: 'native', legacy_order_id: null, migration_run_id: null, source_sha256: null, imported_at_utc: null }
  const legacy = { ...native, id: '2', order_number: 'legacy', external_order_id: 'legacy-external', order_amount: '300',
    legacy_amount_confirmed: '1', status: 'cancelled', origin: 'legacy_import', legacy_order_id: '42', migration_run_id: runId,
    source_sha256: 'b'.repeat(64), imported_at_utc: '2026-09-07 01:00:00.000' }
  const insert = row => connection.execute(`INSERT INTO payment_orders (${Object.keys(native).map(key => `\`${key}\``).join(',')}) VALUES (${Object.keys(native).map(() => '?').join(',')})`, Object.keys(native).map(key => row[key]))
  await insert(native); await insert(legacy)
  await insert({ ...native, id: '3', order_number: 'full-credit', order_amount: '5', referral_credit_applied: '5', status: 'paid', paid_at_utc: '2026-09-07 00:01:00.000' })
  const cases = [
    ['negative_amount', { order_amount: '-1' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['excess_credit', { referral_credit_applied: '301' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['negative_confirmed', { legacy_amount_confirmed: '-1' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['missing_origin_evidence', { source_sha256: null }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['native_with_legacy', { origin: 'native' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['missing_run', { migration_run_id: 'ffffffff-ffff-4fff-8fff-fffffffffff3' }, 'ER_NO_REFERENCED_ROW_2'],
    ['missing_user', { user_id: '-2147482899' }, 'ER_NO_REFERENCED_ROW_2'],
    ['duplicate_legacy', { legacy_order_id: '42' }, 'ER_DUP_ENTRY'],
    ['duplicate_order_number', { order_number: 'LEGACY' }, 'ER_DUP_ENTRY'],
    ['duplicate_external_id', { external_order_id: 'LEGACY-EXTERNAL' }, 'ER_DUP_ENTRY'],
    ['paid_without_time', { status: 'paid' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['zero_revision', { revision: '0' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['unknown_status', { status: 'unknown' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['created_time_missing', { created_at_utc: null }, 'ER_BAD_NULL_ERROR'],
  ]
  const outcomes = []
  for (const [i, [name, changes, expected]] of cases.entries()) {
    const row = { ...legacy, id: String(i + 10), legacy_order_id: String(i + 100), order_number: name, external_order_id: name, ...changes }
    let code = null
    try { await insert(row) } catch (error) { code = error.code }
    check(code === expected, `payment_order_probe_${name}`); outcomes.push({ name, code })
  }
  const [[readback]] = await connection.query('SELECT order_amount,legacy_amount_confirmed,referral_credit_applied FROM payment_orders WHERE id=2')
  check(readback.order_amount === '300.00000000' && readback.legacy_amount_confirmed === '1.00000000' && readback.referral_credit_applied === '0.00000000', 'payment_order_probe_amount_roundtrip')
  await connection.rollback()
  const [[count]] = await connection.query('SELECT COUNT(*) n FROM payment_orders')
  const [[users]] = await connection.execute('SELECT COUNT(*) n FROM users WHERE id=?', [userId])
  const [[runs]] = await connection.execute('SELECT COUNT(*) n FROM data_migration_runs WHERE id=?', [runId])
  check(Number(count.n) === 0 && Number(users.n) === 0 && Number(runs.n) === 0, 'payment_order_probe_rollback')
  const report = { kind: 'payment-order-schema-probe/v1', identity, sourceSqlSha256: sha(sql), ddl: definition['Create Table'],
    acceptedInserts: 3, rejectedCases: outcomes, amountRoundtrip: true, rolledBack: true, paymentOrderRows: 0, sourceDatabaseWritten: false }
  const file = await open(new URL('receipt.json', base), 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(report, null, 2) + '\n'); await file.sync() } finally { await file.close() }
  console.log(JSON.stringify({ status: 'verified', acceptedInserts: 3, rejectedCases: outcomes.length, rolledBack: true }))
} catch (error) {
  await connection?.rollback().catch(() => {})
  console.error(JSON.stringify({ code: /^payment_order_probe_[a-z_]+$/.test(error.message) ? error.message : error.code ?? 'payment_order_probe_failed' })); process.exitCode = 1
} finally { await connection?.end() }
