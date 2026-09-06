import { readFile, open } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'
const base = new URL('./', import.meta.url)
const check = (ok, code) => { if (!ok) throw new Error(code) }
const userId = '-2147482800', otherUser = '-2147482799', runId = 'ffffffff-ffff-4fff-8fff-fffffffffff4'
let connection
try {
  check(process.platform === 'linux' && process.getuid() === 0, 'payment_match_probe_scope')
  const sql = await readFile(new URL('013_payment_matches.sql', base), 'utf8'), statements = splitSqlStatements(sql)
  check(statements.length === 2, 'payment_match_probe_statements')
  const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
  const credentials = JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`, 'utf8'))
  connection = await mysql.createConnection({ ...credentials, database: 'dev_vue_m1_a', dateStrings: true, timezone: 'Z', multipleStatements: false })
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
  check(identity.db === 'dev_vue_m1_a' && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'payment_match_probe_identity')
  await connection.query("SET SESSION time_zone='+00:00'")
  const [[exists]] = await connection.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('payment_transactions','payment_matches')")
  check(Number(exists.n) === 0, 'payment_match_probe_already_created')
  const definitions = []
  for (const [i, table] of ['payment_transactions', 'payment_matches'].entries()) {
    await connection.query(statements[i])
    const [[row]] = await connection.query(`SHOW CREATE TABLE \`${table}\``)
    definitions.push({ table, ddl: row['Create Table'] })
  }
  await connection.beginTransaction()
  for (const id of [userId, otherUser]) await connection.execute("INSERT INTO users (id,password,created_at,updated_at) VALUES (?,'disabled-schema-fixture',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [id])
  await connection.execute("INSERT INTO data_migration_runs (id,bindings_sha256,bindings_json,created_at_utc) VALUES (?,?,'{}',UTC_TIMESTAMP(3))", [runId, 'a'.repeat(64)])
  for (const id of ['201', '202', '203', '204']) await connection.execute("INSERT INTO payment_orders (id,user_id,order_number,product_code,order_amount,referral_credit_applied,status,created_at_utc,origin) VALUES (?,?,?,'plus',1,0,'pending','2026-09-07 00:00:00','native')", [id, userId, `match-probe-${id}`])
  const insert = (table, row) => connection.execute(`INSERT INTO \`${table}\` (${Object.keys(row).map(k => `\`${k}\``).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`, Object.values(row))
  const transaction = { id: '301', chain: 'TRON', transaction_hash: 'a'.repeat(64), asset_contract: 'fixture-contract', asset_code: 'USDT', recipient_address: 'fixture-address', received_amount: '1.00000001', occurred_at_utc: '2026-09-07 00:01:00.000', first_observed_at_utc: '2026-09-07 00:01:01.000', last_observed_at_utc: '2026-09-07 00:01:01.000', confirmations: '20', evidence_sha256: 'b'.repeat(64) }
  await insert('payment_transactions', transaction)
  await insert('payment_transactions', { ...transaction, id: '302', transaction_hash: 'e'.repeat(64) })
  const pending = { id: '401', payment_order_id: '201', user_id: userId, chain: 'TRON', asset_contract: 'fixture-contract', recipient_address: 'fixture-address', expected_amount: '1.00000000', required_confirmations: '19', payment_transaction_id: null, status: 'pending', window_start_at_utc: '2026-09-07 00:00:00.000', expires_at_utc: '2026-09-07 01:00:00.000', created_at_utc: '2026-09-07 00:00:01.000', origin: 'native' }
  await insert('payment_matches', pending)
  await insert('payment_matches', { ...pending, id: '402', payment_order_id: '202', payment_transaction_id: '301', status: 'confirming' })
  const legacyFields = { origin: 'legacy_import', legacy_watch_id: '1', legacy_confirmations: '0', legacy_wallet_index: '0', migration_run_id: runId, source_sha256: 'c'.repeat(64), imported_at_utc: '2026-09-07 02:00:00.000' }
  await insert('payment_matches', { ...pending, ...legacyFields, id: '403', payment_order_id: '203', status: 'expired', created_at_utc: null })
  const cases = [
    ['cross_user', { user_id: otherUser }, 'ER_NO_REFERENCED_ROW_2'],
    ['cross_address', { recipient_address: 'other', payment_transaction_id: '302', status: 'confirming' }, 'ER_NO_REFERENCED_ROW_2'],
    ['cross_asset', { asset_contract: 'other', payment_transaction_id: '302', status: 'confirming' }, 'ER_NO_REFERENCED_ROW_2'],
    ['cross_chain', { chain: 'OTHER', payment_transaction_id: '302', status: 'confirming' }, 'ER_NO_REFERENCED_ROW_2'],
    ['duplicate_order', { payment_order_id: '201' }, 'ER_DUP_ENTRY'],
    ['duplicate_claim', { payment_transaction_id: '301', status: 'confirming' }, 'ER_DUP_ENTRY'],
    ['missing_order', { payment_order_id: '999' }, 'ER_NO_REFERENCED_ROW_2'],
    ['missing_run', { ...legacyFields, legacy_watch_id: '2', migration_run_id: 'ffffffff-ffff-4fff-8fff-fffffffffff5' }, 'ER_NO_REFERENCED_ROW_2'],
    ['negative_expected', { expected_amount: '-1' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['zero_confirmations', { required_confirmations: '0' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['native_null_policy', { required_confirmations: null }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['invalid_window', { expires_at_utc: pending.window_start_at_utc }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['unknown_status', { status: 'unknown' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['confirmed_without_transaction', { status: 'confirmed' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['pending_with_transaction', { payment_transaction_id: '301' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ]
  const outcomes = []
  for (const [i, [name, changes, expected]] of cases.entries()) {
    let code = null
    try { await insert('payment_matches', { ...pending, id: String(i + 500), payment_order_id: '204', ...changes }) } catch (error) { code = error.code }
    check(code === expected, `payment_match_probe_${name}`); outcomes.push({ name, code })
  }
  for (const [name, changes, expected] of [
    ['duplicate_hash_case', { transaction_hash: 'A'.repeat(64) }, 'ER_DUP_ENTRY'],
    ['zero_received', { transaction_hash: 'd'.repeat(64), received_amount: '0' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['invalid_observation', { transaction_hash: 'd'.repeat(64), last_observed_at_utc: '2026-09-06 00:00:00' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ]) {
    let code = null
    try { await insert('payment_transactions', { ...transaction, id: '303', ...changes }) } catch (error) { code = error.code }
    check(code === expected, `payment_match_probe_${name}`); outcomes.push({ name, code })
  }
  const [[amounts]] = await connection.query('SELECT m.expected_amount,t.received_amount FROM payment_matches m JOIN payment_transactions t ON t.id=m.payment_transaction_id WHERE m.id=402')
  check(amounts.expected_amount === '1.00000000' && amounts.received_amount === '1.00000001', 'payment_match_probe_amounts')
  await connection.rollback()
  const [[counts]] = await connection.query('SELECT (SELECT COUNT(*) FROM payment_matches) matches_count,(SELECT COUNT(*) FROM payment_transactions) transactions_count,(SELECT COUNT(*) FROM payment_orders WHERE id BETWEEN 201 AND 204) orders_count')
  const [[users]] = await connection.execute('SELECT COUNT(*) n FROM users WHERE id IN (?,?)', [userId, otherUser])
  const [[runs]] = await connection.execute('SELECT COUNT(*) n FROM data_migration_runs WHERE id=?', [runId])
  check(Object.values(counts).every(n => Number(n) === 0) && Number(users.n) === 0 && Number(runs.n) === 0, 'payment_match_probe_rollback')
  const report = { kind: 'payment-match-schema-probe/v1', identity, sourceSqlSha256: sha256(sql), definitions,
    acceptedTransactions: 2, acceptedMatches: 3, rejectedCases: outcomes, amountDifferencePreserved: true, rolledBack: true, counts, sourceDatabaseWritten: false }
  const file = await open(new URL('receipt.json', base), 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(report, null, 2) + '\n'); await file.sync() } finally { await file.close() }
  console.log(JSON.stringify({ status: 'verified', rejectedCases: outcomes.length, rolledBack: true }))
} catch (error) {
  await connection?.rollback().catch(() => {})
  console.error(JSON.stringify({ code: /^payment_match_probe_[a-z_]+$/.test(error.message) ? error.message : error.code ?? 'payment_match_probe_failed' })); process.exitCode = 1
} finally { await connection?.end() }
