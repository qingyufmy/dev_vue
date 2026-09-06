import { readFile, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const sha = value => createHash('sha256').update(value).digest('hex')
const base = new URL('./', import.meta.url)
const runId = 'ffffffff-ffff-4fff-8fff-fffffffffff1', userId = '-2147483000'
const check = (ok, code) => { if (!ok) throw new Error(code) }
let connection
try {
  check(process.platform === 'linux' && process.getuid() === 0, 'ledger_probe_scope')
  const sql = await readFile(new URL('011_referral_credit_ledger.sql', base), 'utf8')
  const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
  const credentials = JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`, 'utf8'))
  connection = await mysql.createConnection({ ...credentials, database: 'dev_vue_m1_a', dateStrings: true, timezone: 'Z', multipleStatements: false })
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
  check(identity.db === 'dev_vue_m1_a' && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'ledger_probe_identity')
  await connection.query("SET SESSION time_zone='+00:00'")
  const [[exists]] = await connection.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='referral_credit_ledger'")
  check(Number(exists.n) === 0, 'ledger_probe_already_created')
  await connection.query(sql)
  const [[definition]] = await connection.query('SHOW CREATE TABLE referral_credit_ledger')
  await connection.beginTransaction()
  await connection.execute("INSERT INTO users (id,password,created_at,updated_at) VALUES (?,'disabled-schema-fixture',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [userId])
  await connection.execute("INSERT INTO user_referral_accounts (user_id,referral_credit,updated_at_utc) VALUES (?,'-1.00000000',UTC_TIMESTAMP(3))", [userId])
  await connection.execute("INSERT INTO data_migration_runs (id,bindings_sha256,bindings_json,created_at_utc) VALUES (?,?,'{}',UTC_TIMESTAMP(3))", [runId, 'a'.repeat(64)])
  const insert = 'INSERT INTO referral_credit_ledger (user_id,account_revision,event_kind,source_key,previous_balance,delta,resulting_balance,migration_run_id,source_sha256,recorded_at_utc) VALUES (?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))'
  const opening = [userId, '1', 'opening', 'b'.repeat(64), null, null, '-1.00000000', runId, 'c'.repeat(64)]
  await connection.execute(insert, opening)
  const cases = [
    ['duplicate_revision', { 3: 'd'.repeat(64) }, 'ER_DUP_ENTRY'],
    ['opening_revision', { 1: '2', 3: 'e'.repeat(64) }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['opening_delta', { 5: '1', 3: 'e'.repeat(64) }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['opening_without_run', { 7: null, 3: 'e'.repeat(64) }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    
  ]
  const outcomes = []
  for (const [name, changes, expected] of cases) {
    const values = [...opening]; for (const [key, value] of Object.entries(changes)) values[Number(key)] = value
    let code = null
    try { await connection.execute(insert, values) } catch (error) { code = error.code }
    check(code === expected, `ledger_probe_${name}`); outcomes.push({ name, code })
  }
  const credit = [userId, '2', 'commission_credit', 'f'.repeat(64), '-1', '2', '1', null, 'c'.repeat(64)]
  await connection.execute(insert, credit)
  for (const [name, changes, expected] of [
    ['duplicate_event', { 1: '3' }, 'ER_DUP_ENTRY'],
    ['missing_account', { 0: '-2147482999', 1: '3' }, 'ER_NO_REFERENCED_ROW_2'],
    ['wrong_sum', { 1: '3', 3: 'd'.repeat(64), 6: '2' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['null_delta', { 1: '3', 3: 'd'.repeat(64), 5: null }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['zero_credit', { 1: '3', 3: 'd'.repeat(64), 5: '0', 6: '-1' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['overdraft', { 1: '3', 2: 'order_debit', 3: 'd'.repeat(64), 4: '1', 5: '-2', 6: '-1' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ]) {
    const values = [...credit]; for (const [key, value] of Object.entries(changes)) values[Number(key)] = value
    let code = null
    try { await connection.execute(insert, values) } catch (error) { code = error.code }
    check(code === expected, `ledger_probe_${name}`); outcomes.push({ name, code })
  }
  await connection.rollback()
  const [[count]] = await connection.query('SELECT COUNT(*) n FROM referral_credit_ledger')
  const [[users]] = await connection.execute('SELECT COUNT(*) n FROM users WHERE id=?', [userId])
  const [[runs]] = await connection.execute('SELECT COUNT(*) n FROM data_migration_runs WHERE id=?', [runId])
  check(Number(count.n) === 0 && Number(users.n) === 0 && Number(runs.n) === 0, 'ledger_probe_rollback_failed')
  const report = { kind: 'referral-ledger-schema-probe/v1', identity, sourceSqlSha256: sha(sql), ddl: definition['Create Table'],
    acceptedInserts: 2, rejectedCases: outcomes, rolledBack: true, ledgerRows: 0, sourceDatabaseWritten: false }
  const handle = await open(new URL('receipt.json', base), 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); await handle.sync() } finally { await handle.close() }
  console.log(JSON.stringify({ status: 'verified', rejectedCases: outcomes.length, rolledBack: true }))
} catch (error) {
  await connection?.rollback().catch(() => {})
  console.error(JSON.stringify({ code: /^ledger_probe_[a-z_]+$/.test(error.message) ? error.message : error.code ?? 'ledger_probe_failed' })); process.exitCode = 1
} finally { await connection?.end() }
