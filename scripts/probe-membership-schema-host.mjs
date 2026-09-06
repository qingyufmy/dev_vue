import { readFile, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
const base = new URL('./', import.meta.url)
const sha = value => createHash('sha256').update(value).digest('hex')
const check = (ok, code) => { if (!ok) throw new Error(code) }
const userId = '-2147482800', runId = 'ffffffff-ffff-4fff-8fff-fffffffffffe'
let connection
try {
  check(process.platform === 'linux' && process.getuid() === 0, 'membership_probe_scope')
  const sql = await readFile(new URL('014_memberships.sql', base), 'utf8')
  const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
  const credentials = JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`, 'utf8'))
  connection = await mysql.createConnection({ ...credentials, database: 'dev_vue_m1_a', dateStrings: true, timezone: 'Z', multipleStatements: false })
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
  check(identity.db === 'dev_vue_m1_a' && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'membership_probe_identity')
  await connection.query("SET SESSION time_zone='+00:00'")
  const [[exists]] = await connection.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='memberships'")
  check(Number(exists.n) === 0, 'membership_probe_already_created')
  await connection.query(sql)
  const [[definition]] = await connection.query('SHOW CREATE TABLE memberships')
  await connection.beginTransaction()
  await connection.execute("INSERT INTO users (id,password,created_at,updated_at) VALUES (?,'disabled-schema-fixture',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [userId])
  await connection.execute("INSERT INTO data_migration_runs (id,bindings_sha256,bindings_json,created_at_utc) VALUES (?,?,'{}',UTC_TIMESTAMP(3))", [runId, 'a'.repeat(64)])
  for (const id of ['-2147482799', '-2147482798']) await connection.execute("INSERT INTO users (id,password,created_at,updated_at) VALUES (?,'disabled-schema-fixture',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [id])
  const native = { user_id: userId, plan_code: 'pro', billing_period_code: '', source_code: null,
    expiration_kind: 'no_expiry', expires_at_utc: null, current_state_observed_at_utc: '2026-09-07 00:00:00.123',
    revision: '1', origin: 'native', migration_run_id: null, source_sha256: null, imported_at_utc: null }
  const legacy = { ...native, user_id: '-2147482799', expiration_kind: 'at_time', expires_at_utc: '2026-01-01 05:14:15.123',
    origin: 'legacy_import', migration_run_id: runId, source_sha256: 'b'.repeat(64), imported_at_utc: '2026-09-07 01:00:00.000' }
  const insert = row => connection.execute(`INSERT INTO memberships (${Object.keys(native).join(',')}) VALUES (${Object.keys(native).map(() => '?').join(',')})`, Object.keys(native).map(key => row[key]))
  await insert(native); await insert(legacy)
  const cases = [
    ['unknown_plan', { plan_code: 'unknown' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['no_expiry_with_time', { expiration_kind: 'no_expiry' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['at_time_without_time', { expires_at_utc: null }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['unknown_expiration', { expiration_kind: 'unknown' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['zero_revision', { revision: '0' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['missing_origin_evidence', { source_sha256: null }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['native_with_import', { origin: 'native' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['missing_run', { migration_run_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, 'ER_NO_REFERENCED_ROW_2'],
    ['missing_user', { user_id: '-2147482797' }, 'ER_NO_REFERENCED_ROW_2'],
    ['duplicate_user', { user_id: userId }, 'ER_DUP_ENTRY'],
    ['missing_observation', { current_state_observed_at_utc: null }, 'ER_BAD_NULL_ERROR'],
  ]
  const outcomes = []
  for (const [name, changes, expected] of cases) {
    let code = null
    try { await insert({ ...legacy, user_id: '-2147482798', ...changes }) } catch (error) { code = error.code }
    check(code === expected, `membership_probe_${name}`); outcomes.push({ name, code })
  }
  const [[readback]] = await connection.execute('SELECT plan_code,billing_period_code,source_code,expires_at_utc FROM memberships WHERE user_id=?', [legacy.user_id])
  check(readback.plan_code === 'pro' && readback.billing_period_code === '' && readback.source_code === null
    && readback.expires_at_utc === '2026-01-01 05:14:15.123', 'membership_probe_roundtrip')
  await connection.rollback()
  const [[count]] = await connection.query('SELECT COUNT(*) n FROM memberships')
  const [[users]] = await connection.execute('SELECT COUNT(*) n FROM users WHERE id IN (-2147482800,-2147482799,-2147482798)', [])
  const [[runs]] = await connection.execute('SELECT COUNT(*) n FROM data_migration_runs WHERE id=?', [runId])
  check(Number(count.n) === 0 && Number(users.n) === 0 && Number(runs.n) === 0, 'membership_probe_rollback')
  const report = { kind: 'membership-schema-probe/v1', identity, sourceSqlSha256: sha(sql), ddl: definition['Create Table'],
    acceptedInserts: 2, rejectedCases: outcomes, stateRoundtrip: true, rolledBack: true, membershipRows: 0, sourceDatabaseWritten: false }
  const file = await open(new URL('receipt.json', base), 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(report, null, 2) + '\n'); await file.sync() } finally { await file.close() }
  console.log(JSON.stringify({ status: 'verified', acceptedInserts: 2, rejectedCases: outcomes.length, rolledBack: true }))
} catch (error) {
  await connection?.rollback().catch(() => {})
  console.error(JSON.stringify({ code: /^membership_probe_[a-z_]+$/.test(error.message) ? error.message : error.code ?? 'membership_probe_failed' })); process.exitCode = 1
} finally { await connection?.end() }
